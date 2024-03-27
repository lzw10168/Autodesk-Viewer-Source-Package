"use strict";

const NodeType = {
    NI_Inner: 0,
    NI_Leaf: 1,
};

function readUuid(pfr) {
    let uuid = ''; // uuid should be a 16 bytes long
    for (let i = 0; i < 16; i++) {
        const tempUuid = pfr.readU8();
        uuid = uuid + tempUuid;
    }
    return uuid;
}

function readNamedItemNode(pfr) {

    const name = pfr.readString();
    let uuid = readUuid(pfr);
    const type = pfr.readU8();

    if (type === NodeType.NI_Leaf) {
        const entry = pfr.readVarint();
        return {
            name: name,
            entry: entry,
            uuid
        };
    } else if (type === NodeType.NI_Inner) {
        const count = pfr.readVarint();
        const children = [];
        for (let i = 0; i < count; i++) {
            const child = readNamedItemNode(pfr);
            children.push(child);
        }
        return {
            name: name,
            children: children
        };
    } else {
        return {};
    }
}

export function readNamedItemTree(pfr) {
    if (pfr.seekToEntry) {
        pfr.seekToEntry(0);
    }
    return readNamedItemNode(pfr);
}