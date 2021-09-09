/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import {EventKey} from "../EventKey";
import {EventEntry} from "../entries/EventEntry.js";
import {Direction} from "../Direction";
import {FragmentBoundaryEntry} from "../entries/FragmentBoundaryEntry.js";
import {createEventEntry, directionalAppend} from "./common.js";
import {RoomMember, EVENT_TYPE as MEMBER_EVENT_TYPE} from "../../members/RoomMember.js";

export class GapWriter {
    constructor({roomId, storage, fragmentIdComparer, relationWriter}) {
        this._roomId = roomId;
        this._storage = storage;
        this._fragmentIdComparer = fragmentIdComparer;
        this._relationWriter = relationWriter;
    }
    // events is in reverse-chronological order (last event comes at index 0) if backwards
    async _findOverlappingEventsFor(currentFragmentId, linkedFragmentId, direction, events, txn, log) {
        let expectedOverlappingEventId;
        if (linkedFragmentId !== null) {
            expectedOverlappingEventId = await this._findExpectedOverlappingEventId(linkedFragmentId, direction, txn);
        }
        let remainingEvents = events;
        let nonOverlappingEvents = [];
        let neighbourFragmentEntry;
        while (remainingEvents && remainingEvents.length) {
            const eventIds = remainingEvents.map(e => e.event_id);
            const duplicateEventId = await txn.timelineEvents.findFirstOccurringEventId(this._roomId, eventIds);
            if (duplicateEventId) {
                const duplicateEventIndex = remainingEvents.findIndex(e => e.event_id === duplicateEventId);
                // should never happen, just being defensive as this *can't* go wrong
                if (duplicateEventIndex === -1) {
                    throw new Error(`findFirstOccurringEventId returned ${duplicateEventIndex} which wasn't ` +
                        `in [${eventIds.join(",")}] in ${this._roomId}`);
                }
                nonOverlappingEvents.push(...remainingEvents.slice(0, duplicateEventIndex));
                if (!expectedOverlappingEventId || duplicateEventId === expectedOverlappingEventId) {
                    // Only link fragment if this is the first overlapping fragment we discover.
                    // TODO is this sufficient? Might we get "out of order" fragments from events?
                    if (!neighbourFragmentEntry) {
                        // TODO: check here that the neighbourEvent is at the correct edge of it's fragment
                        // get neighbour fragment to link it up later on
                        const neighbourEvent = await txn.timelineEvents.getByEventId(this._roomId, duplicateEventId);
                        const neighbourFragment = await txn.timelineFragments.get(this._roomId, neighbourEvent.fragmentId);
                        neighbourFragmentEntry = new FragmentBoundaryEntry(neighbourFragment, direction.isForward, this._fragmentIdComparer);
                    }
                } 
                // If more events remain, or if this wasn't the expected overlapping event,
                // we've hit https://github.com/matrix-org/synapse/issues/7164, 
                // e.g. the event id we found is already in our store but it is not
                // the adjacent fragment id. Ignore the event, but keep processing the ones after.
                remainingEvents = remainingEvents.slice(duplicateEventIndex + 1);
            } else {
                nonOverlappingEvents.push(...remainingEvents);
                remainingEvents = null;
            }
        }
        if (neighbourFragmentEntry?.fragmentId === currentFragmentId) {
            log.log("hit #160, prevent fragment linking to itself", log.level.Warn);
            neighbourFragmentEntry = null;
        } 
        return {nonOverlappingEvents, neighbourFragmentEntry};
    }

    async _findOverlappingEvents(fragmentEntry, events, txn, log) {
        const linkedFragmentId = fragmentEntry.hasLinkedFragment ? fragmentEntry.linkedFragmentId : null;
        return this._findOverlappingEventsFor(fragmentEntry.fragmentId, linkedFragmentId, fragmentEntry.direction, events, txn, log);
    }

    async _findExpectedOverlappingEventId(linkedFragmentId, direction, txn) {
        const eventEntry = await this._findFragmentEdgeEvent(
            linkedFragmentId,
            // reverse because it's the oppose edge of the linked fragment
            direction.reverse(),
            txn);
        if (eventEntry) {
            return eventEntry.event.event_id;
        }
    }

    async _findFragmentEdgeEventKey(fragmentEntry, txn) {
        const {fragmentId, direction} = fragmentEntry;
        const event = await this._findFragmentEdgeEvent(fragmentId, direction, txn);
        if (event) {
            return new EventKey(event.fragmentId, event.eventIndex);
        } else {
            // no events yet in the fragment ... odd, but let's not fail and take the default key
            return EventKey.defaultFragmentKey(fragmentEntry.fragmentId);
        }
    }

    async _findFragmentEdgeEvent(fragmentId, direction, txn) {
        if (direction.isBackward) {
            const [firstEvent] = await txn.timelineEvents.firstEvents(this._roomId, fragmentId, 1);
            return firstEvent;
        } else {
            const [lastEvent] = await txn.timelineEvents.lastEvents(this._roomId, fragmentId, 1);
            return lastEvent;
        }
    }

    async _storeEvents(events, startKey, direction, state, txn, log) {
        const entries = [];
        const updatedEntries = [];
        // events is in reverse chronological order for backwards pagination,
        // e.g. order is moving away from the `from` point.
        let key = startKey;
        for (let i = 0; i < events.length; ++i) {
            const event = events[i];
            key = key.nextKeyForDirection(direction);
            const eventStorageEntry = createEventEntry(key, this._roomId, event);
            const member = this._findMember(event.sender, state, events, i, direction);
            if (member) {
                eventStorageEntry.displayName = member.displayName;
                eventStorageEntry.avatarUrl = member.avatarUrl;
            }
            // this will modify eventStorageEntry if it is a relation target
            const updatedRelationTargetEntries = await this._relationWriter.writeGapRelation(eventStorageEntry, direction, txn, log);
            if (updatedRelationTargetEntries) {
                updatedEntries.push(...updatedRelationTargetEntries);
            }
            txn.timelineEvents.insert(eventStorageEntry);
            const eventEntry = new EventEntry(eventStorageEntry, this._fragmentIdComparer);
            directionalAppend(entries, eventEntry, direction);
        }
        return {entries, updatedEntries};
    }

    _findMember(userId, state, events, index, direction) {
        function isOurUser(event) {
            return event.type === MEMBER_EVENT_TYPE && event.state_key === userId;
        }
        // older messages are at a higher index in the array when going backwards
        const inc = direction.isBackward ? 1 : -1;
        for (let i = index + inc; i >= 0 && i < events.length; i += inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromMemberEvent(this._roomId, event);
            }
        }
        // look into newer events, but using prev_content if found.
        // We do this before looking into `state` because it is not well specified
        // in the spec whether the events in there represent state before or after `chunk`.
        // So we look both directions first in chunk to make sure it doesn't matter.
        for (let i = index; i >= 0 && i < events.length; i -= inc) {
            const event = events[i];
            if (isOurUser(event)) {
                return RoomMember.fromReplacingMemberEvent(this._roomId, event);
            }
        }
        // assuming the member hasn't changed within the chunk, just take it from state if it's there.
        // Don't assume state is set though, as it can be empty at the top of the timeline in some circumstances 
        const stateMemberEvent = state?.find(isOurUser);
        if (stateMemberEvent) {
            return RoomMember.fromMemberEvent(this._roomId, stateMemberEvent);
        }
    }

    async _updateFragments(fragmentEntry, neighbourFragmentEntry, end, entries, txn) {
        const {direction} = fragmentEntry;
        const changedFragments = [];
        directionalAppend(entries, fragmentEntry, direction);
        // set `end` as token, and if we found an event in the step before, link up the fragments in the fragment entry
        if (neighbourFragmentEntry) {
            // the throws here should never happen and are only here to detect client or unhandled server bugs
            // and a last measure to prevent corrupting fragment links
            if (!fragmentEntry.hasLinkedFragment) {
                fragmentEntry.linkedFragmentId = neighbourFragmentEntry.fragmentId;
            } else if (fragmentEntry.linkedFragmentId !== neighbourFragmentEntry.fragmentId) {
                throw new Error(`Prevented changing fragment ${fragmentEntry.fragmentId} ` +
                    `${fragmentEntry.direction.asApiString()} link from ${fragmentEntry.linkedFragmentId} ` +
                    `to ${neighbourFragmentEntry.fragmentId} in ${this._roomId}`);
            }
            if (!neighbourFragmentEntry.hasLinkedFragment) {
                neighbourFragmentEntry.linkedFragmentId = fragmentEntry.fragmentId;
            } else if (neighbourFragmentEntry.linkedFragmentId !== fragmentEntry.fragmentId) {
                throw new Error(`Prevented changing fragment ${neighbourFragmentEntry.fragmentId} ` +
                    `${neighbourFragmentEntry.direction.asApiString()} link from ${neighbourFragmentEntry.linkedFragmentId} ` +
                    `to ${fragmentEntry.fragmentId} in ${this._roomId}`);
            }
            // if neighbourFragmentEntry was found, it means the events were overlapping,
            // so no pagination should happen anymore.
            neighbourFragmentEntry.token = null;
            fragmentEntry.token = null;

            txn.timelineFragments.update(neighbourFragmentEntry.fragment);
            directionalAppend(entries, neighbourFragmentEntry, direction);

            // fragments that need to be changed in the fragmentIdComparer here
            // after txn succeeds
            changedFragments.push(fragmentEntry.fragment);
            changedFragments.push(neighbourFragmentEntry.fragment);
        } else {
            fragmentEntry.token = end;
        }
        txn.timelineFragments.update(fragmentEntry.fragment);

        return changedFragments;
    }

    /* If searching for overlapping entries in two directions, 
     * combine the results of the two searches.
     *
     * @param mainOverlap the result of a search that located an existing fragment.
     * @param otherOverlap the result of a search in the opposite direction to mainOverlap.
     * @param event the event from which the two-directional search occured.
     * @param token the new pagination token for mainOverlap.
     */
    async _linkOverlapping(mainOverlap, otherOverlap, event, token, state, txn, log) {
        const fragmentEntry = mainOverlap.neighbourFragmentEntry;
        const otherEntry = otherOverlap.neighbourFragmentEntry;

        // We're filling the entry from the opposite direction that the search occured
        // (e.g. searched up, filling down). Thus, the events need to be added in the opposite
        // order.
        const allEvents = mainOverlap.nonOverlappingEvents.reverse();
        allEvents.push(event, ...otherOverlap.nonOverlappingEvents);

        // TODO Very important: can the 'up' and 'down' entries be the same? If that's
        // the case, we can end up with a self-link (and thus infinite loop).

        let lastKey = await this._findFragmentEdgeEventKey(fragmentEntry, txn);
        const {entries, updatedEntries} = await this._storeEvents(allEvents, lastKey, fragmentEntry.direction, state, txn, log);
        const fragments = await this._updateFragments(fragmentEntry, otherEntry, token, entries, txn);
        const contextEvent = entries.find(e => e.id === event.event_id) || null;
        return { entries, updatedEntries, fragments, contextEvent };
    }

    async _createNewFragment(txn) {
        const maxFragmentKey = await txn.timelineFragments.getMaxFragmentId(this._roomId);
        const newFragment = {
            roomId: this._roomId,
            id: maxFragmentKey + 1,
            previousId: null,
            nextId: null,
            previousToken: null,
            nextToken: null
        };
        txn.timelineFragments.add(newFragment);
        return newFragment;
    }

    async writeContext(response, txn, log) {
        const {
            events_before: eventsBefore,
            events_after: eventsAfter,
            event, state, start, end
        } = response;

        if (!Array.isArray(eventsBefore) || !Array.isArray(eventsAfter)) {
            throw new Error("Invalid chunks in response");
        }

        if (!start || !end) {
            throw new Error("Context call did not receive start and end tokens");
        }

        const eventEntry = await txn.timelineEvents.getByEventId(this._roomId, event.event_id);
        if (eventEntry) {
            // If we have the current event, eary return.
            return { entries: [], updatedEntries: [], fragments: [], contextEvent: new EventEntry(eventEntry, this._fragmentIdComparer) }
        }

        const overlapUp = await this._findOverlappingEventsFor(null, null, Direction.Backward, eventsBefore, txn, log);
        const overlapDown = await this._findOverlappingEventsFor(null, null, Direction.Forward, eventsAfter, txn, log);
        if (overlapUp.neighbourFragmentEntry) {
            return this._linkOverlapping(overlapUp, overlapDown, event, end, state, txn, log);
        } else if (overlapDown.neighbourFragmentEntry) {
            return this._linkOverlapping(overlapDown, overlapUp, event, start, state, txn, log);
        }

        // No overlapping fragments found.
        const newFragment = await this._createNewFragment(txn);
        newFragment.nextToken = end;
        newFragment.previousToken = start;
        // Pretend that we did find an overlapping entry above, and that this entry is for the new fragment.
        const newEntry = FragmentBoundaryEntry.end(newFragment, this._fragmentIdComparer);
        overlapUp.neighbourFragmentEntry = newEntry;
        return this._linkOverlapping(overlapUp, overlapDown, event, end, state, txn, log);
    }

    async writeFragmentFill(fragmentEntry, response, txn, log) {
        const {fragmentId, direction} = fragmentEntry;
        // chunk is in reverse-chronological order when backwards
        const {chunk, start, state} = response;
        let {end} = response;

        if (!Array.isArray(chunk)) {
            throw new Error("Invalid chunk in response");
        }
        if (typeof end !== "string") {
            throw new Error("Invalid end token in response");
        }

        // make sure we have the latest fragment from the store
        const fragment = await txn.timelineFragments.get(this._roomId, fragmentId);
        if (!fragment) {
            throw new Error(`Unknown fragment: ${fragmentId}`);
        }
        fragmentEntry = fragmentEntry.withUpdatedFragment(fragment);
        // check that the request was done with the token we are aware of (extra care to avoid timeline corruption)
        if (fragmentEntry.token !== start) {
            throw new Error("start is not equal to prev_batch or next_batch");
        }

        // begin (or end) of timeline reached
        if (chunk.length === 0) {
            fragmentEntry.edgeReached = true;
            await txn.timelineFragments.update(fragmentEntry.fragment);
            return {entries: [fragmentEntry], updatedEntries: [], fragments: []};
        }

        // find last event in fragment so we get the eventIndex to begin creating keys at
        let lastKey = await this._findFragmentEdgeEventKey(fragmentEntry, txn);
        // find out if any event in chunk is already present using findFirstOrLastOccurringEventId
        const {
            nonOverlappingEvents,
            neighbourFragmentEntry
        } = await this._findOverlappingEvents(fragmentEntry, chunk, txn, log);
        if (!neighbourFragmentEntry && nonOverlappingEvents.length === 0 && typeof end === "string") {
            log.log("hit #160, clearing token", log.level.Warn);
            end = null;
        }
        // create entries for all events in chunk, add them to entries
        const {entries, updatedEntries} = await this._storeEvents(nonOverlappingEvents, lastKey, direction, state, txn, log);
        const fragments = await this._updateFragments(fragmentEntry, neighbourFragmentEntry, end, entries, txn);
    
        return {entries, updatedEntries, fragments};
    }
}

import {FragmentIdComparer} from "../FragmentIdComparer.js";
import {RelationWriter} from "./RelationWriter.js";
import {createMockStorage} from "../../../../mocks/Storage.js";
import {NullLogItem} from "../../../../logging/NullLogger.js";
import {TimelineMock, eventIds, eventId} from "../../../../mocks/TimelineMock.ts";
import {SyncWriter} from "./SyncWriter.js";
import {MemberWriter} from "./MemberWriter.js";
import {KeyLimits} from "../../../storage/common";

export function tests() {
    const roomId = "!room:hs.tdl";
    const alice = "alice@hs.tdl";
    const logger = new NullLogItem();

    async function createGapFillTxn(storage) {
        return storage.readWriteTxn([
            storage.storeNames.roomMembers,
            storage.storeNames.pendingEvents,
            storage.storeNames.timelineEvents,
            storage.storeNames.timelineRelations,
            storage.storeNames.timelineFragments,
        ]);
    }

    async function setup() {
        const storage = await createMockStorage();
        const txn = await createGapFillTxn(storage);
        const fragmentIdComparer = new FragmentIdComparer([]);
        const relationWriter = new RelationWriter({
            roomId, fragmentIdComparer, ownUserId: alice,
        });
        const gapWriter = new GapWriter({
            roomId, storage, fragmentIdComparer, relationWriter
        });
        const memberWriter = new MemberWriter(roomId);
        const syncWriter = new SyncWriter({
            roomId,
            fragmentIdComparer,
            memberWriter,
            relationWriter
        });
        return { storage, txn, fragmentIdComparer, gapWriter, syncWriter, timelineMock: new TimelineMock() };
    }

    async function syncAndWrite(mocks, previousResponse) {
        const {txn, timelineMock, syncWriter, fragmentIdComparer} = mocks;
        const syncResponse = timelineMock.sync(previousResponse?.next_batch);
        const {newLiveKey} = await syncWriter.writeSync(syncResponse, false, false, txn, logger);
        syncWriter.afterSync(newLiveKey);
        return {
            syncResponse,
            fragmentEntry: newLiveKey ? FragmentBoundaryEntry.start(
                await txn.timelineFragments.get(roomId, newLiveKey.fragmentId),
                fragmentIdComparer,
            ) : null,
        };
    }

    async function backfillAndWrite(mocks, fragmentEntry) {
        const {txn, timelineMock, gapWriter} = mocks;
        const messageResponse = timelineMock.messages(fragmentEntry.token, undefined, fragmentEntry.direction.asApiString());
        await gapWriter.writeFragmentFill(fragmentEntry, messageResponse, txn, logger);
    }

    async function allFragmentEvents(mocks, fragmentId) {
        const {txn} = mocks;
        const entries = await txn.timelineEvents.eventsAfter(roomId, new EventKey(fragmentId, KeyLimits.minStorageKey));
        return entries.map(e => e.event);
    }

    async function fetchFragment(mocks, fragmentId) {
        const {txn} = mocks;
        return txn.timelineFragments.get(roomId, fragmentId);
    }

    function assertDeepLink(assert, fragment1, fragment2) {
        assert.equal(fragment1.nextId, fragment2.id);
        assert.equal(fragment2.previousId, fragment1.id);
        assert.equal(fragment1.nextToken, null);
        assert.equal(fragment2.previousToken, null);
    }

    function assertShallowLink(assert, fragment1, fragment2) {
        assert.equal(fragment1.nextId, fragment2.id);
        assert.equal(fragment2.previousId, fragment1.id);
        assert.notEqual(fragment2.previousToken, null);
    }

    return {
        "Backfilling after one sync": async assert => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(30);
            const {fragmentEntry} = await syncAndWrite(mocks);
            await backfillAndWrite(mocks, fragmentEntry);
            const events = await allFragmentEvents(mocks, fragmentEntry.fragmentId);
            assert.deepEqual(events.map(e => e.event_id), eventIds(10, 30));
        },
        "Backfilling a fragment that is expected to link up, and does": async assert => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks);
            timelineMock.append(15);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, syncResponse);
            await backfillAndWrite(mocks, secondFragmentEntry);

            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertDeepLink(assert, firstFragment, secondFragment)
            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), eventIds(10, 25));
        },
        "Backfilling a fragment that is expected to link up, but doesn't yet": async assert => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks);
            timelineMock.append(20);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, syncResponse);
            await backfillAndWrite(mocks, secondFragmentEntry);

            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertShallowLink(assert, firstFragment, secondFragment)
            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), eventIds(10, 30));
        },
        "Receiving a sync with the same events as the current fragment does not create infinite link": async assert => {
            const mocks = await setup();
            const { txn, timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: fragmentEntry} = await syncAndWrite(mocks);
            // Mess with the saved token to receive old events in backfill
            fragmentEntry.token = syncResponse.next_batch;
            txn.timelineFragments.update(fragmentEntry.fragment);
            await backfillAndWrite(mocks, fragmentEntry);

            const fragment = await fetchFragment(mocks, fragmentEntry.fragmentId);
            assert.notEqual(fragment.nextId, fragment.id);
            assert.notEqual(fragment.previousId, fragment.id);
        },
        "An event received by sync does not interrupt backfilling": async assert => {
            const mocks = await setup();
            const { timelineMock } = mocks;
            timelineMock.append(10);
            const {syncResponse, fragmentEntry: firstFragmentEntry} = await syncAndWrite(mocks);
            timelineMock.append(11);
            const {fragmentEntry: secondFragmentEntry} = await syncAndWrite(mocks, syncResponse);
            timelineMock.insertAfter(eventId(9), 5);
            await backfillAndWrite(mocks, secondFragmentEntry);

            const firstEvents = await allFragmentEvents(mocks, firstFragmentEntry.fragmentId);
            assert.deepEqual(firstEvents.map(e => e.event_id), eventIds(0, 10));
            const secondEvents = await allFragmentEvents(mocks, secondFragmentEntry.fragmentId);
            assert.deepEqual(secondEvents.map(e => e.event_id), [...eventIds(21,26), ...eventIds(10, 21)]);
            const firstFragment = await fetchFragment(mocks, firstFragmentEntry.fragmentId);
            const secondFragment = await fetchFragment(mocks, secondFragmentEntry.fragmentId);
            assertDeepLink(assert, firstFragment, secondFragment)
        }
    }
}
