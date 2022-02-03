/*
Copyright 2020 Bruno Windels <bruno@windels.cloud>
Copyright 2020, 2021 The Matrix.org Foundation C.I.C.

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

import {BaseTileViewModel} from "./BaseTileViewModel.js";

export class RoomBeingCreatedTileViewModel extends BaseTileViewModel {
    constructor(options) {
        super(options);
        const {roomBeingCreated} = options;
        this._roomBeingCreated = roomBeingCreated;
        this._url = this.urlCreator.openRoomActionUrl(this._roomBeingCreated.localId);
    }

    get busy() { return true; }

    get kind() {
        return "roomBeingCreated";
    }

    get url() {
        return this._url;
    }

    compare(other) {
        const parentComparison = super.compare(other);
        if (parentComparison !== 0) {
            return parentComparison;
        }
        return other._roomBeingCreated.name.localeCompare(this._roomBeingCreated.name);
    }

    get name() {
        return this._roomBeingCreated.name;
    }

    get _avatarSource() {
        return this._roomBeingCreated;
    }
}