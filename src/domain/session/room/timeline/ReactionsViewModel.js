/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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
import {ObservableMap} from "../../../../observable/map/ObservableMap.js";

export class ReactionsViewModel {
    constructor(parentEntry) {
        this._parentEntry = parentEntry;
        this._map = new ObservableMap();
        this._reactions = this._map.sortValues((a, b) => a._compare(b));
    }

    /** @package */
    update(annotations, pendingAnnotations) {
        if (annotations) {
            for (const key in annotations) {
                if (annotations.hasOwnProperty(key)) {
                    const annotation = annotations[key];
                    const reaction = this._map.get(key);
                    if (reaction) {
                        if (reaction._tryUpdate(annotation)) {
                            this._map.update(key);
                        }
                    } else {
                        this._map.add(key, new ReactionViewModel(key, annotation, null, this._parentEntry));
                    }
                }
            }
        }
        if (pendingAnnotations) {
            for (const [key, count] of pendingAnnotations.entries()) {
                const reaction = this._map.get(key);
                if (reaction) {
                    if (reaction._tryUpdatePending(count)) {
                        this._map.update(key);
                    }
                } else {
                    this._map.add(key, new ReactionViewModel(key, null, count, this._parentEntry));
                }
            }
        }
        for (const existingKey of this._map.keys()) {
            const hasPending = pendingAnnotations?.has(existingKey);
            const hasRemote = annotations?.hasOwnProperty(existingKey);
            if (!hasRemote && !hasPending) {
                this._map.remove(existingKey);
            } else if (!hasRemote) {
                if (this._map.get(existingKey)._tryUpdate(null)) {
                    this._map.update(existingKey);
                }
            } else if (!hasPending) {
                if (this._map.get(existingKey)._tryUpdatePending(null)) {
                    this._map.update(existingKey);
                }
            }
        }
    }

    get reactions() {
        return this._reactions;
    }
}

class ReactionViewModel {
    constructor(key, annotation, pendingCount, parentEntry) {
        this._key = key;
        this._annotation = annotation;
        this._pendingCount = pendingCount;
        this._parentEntry = parentEntry;
        this._isToggling = false;
    }

    _tryUpdate(annotation) {
        const oneSetAndOtherNot = !!this._annotation !== !!annotation;
        const bothSet = this._annotation && annotation;
        const areDifferent = bothSet &&  (
            annotation.me !== this._annotation.me ||
            annotation.count !== this._annotation.count ||
            annotation.firstTimestamp !== this._annotation.firstTimestamp
        );
        if (oneSetAndOtherNot || areDifferent) {
            this._annotation = annotation;
            return true;
        }
        return false;
    }

    _tryUpdatePending(pendingCount) {
        if (pendingCount !== this._pendingCount) {
            this._pendingCount = pendingCount;
            return true;
        }
        return false;
    }

    get key() {
        return this._key;
    }

    get count() {
        let count = this._pendingCount || 0;
        if (this._annotation) {
            count += this._annotation.count;
        }
        return count;
    }

    get isPending() {
        // even if pendingCount is 0,
        // it means we have both a pending reaction and redaction
        return this._pendingCount !== null;
    }

    get haveReacted() {
        return this._annotation?.me || this.isPending;
    }

    _compare(other) {
        // the comparator is also used to test for equality by sortValues, if the comparison returns 0
        // given that the firstTimestamp isn't set anymore when the last reaction is removed,
        // the remove event wouldn't be able to find the correct index anymore. So special case equality.
        if (other === this) {
            return 0;
        }
        if (this.count !== other.count) {
            return other.count - this.count;
        } else {
            const a = this._annotation;
            const b = other._annotation;
            if (a && b) {
                const cmp = a.firstTimestamp - b.firstTimestamp;
                if (cmp === 0) {
                    return this.key < other.key ? -1 : 1;
                } else {
                    return cmp;
                }
            } else if (a) {
                return -1;
            } else {
                return 1;
            }
        }
    }

    async toggleReaction() {
        if (this._isToggling) {
            return;
        }
        this._isToggling = true;
        try {
            // TODO: should some of this go into BaseMessageTile?
            const haveLocalRedaction = this.isPending && this._pendingCount <= 0;
            const havePendingReaction = this.isPending && this._pendingCount > 0;
            const haveRemoteReaction = this._annotation?.me;
            const haveReaction = havePendingReaction || (haveRemoteReaction && !haveLocalRedaction);
            if (haveReaction) {
                await this._parentEntry.redactReaction(this.key);
            } else {
                await this._parentEntry.react(this.key);
            }
        } finally {
            this._isToggling = false;
        }
    }
}