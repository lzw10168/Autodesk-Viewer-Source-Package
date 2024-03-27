"use strict";

const OverrideSetParts = {
    OS_DefaultMaterial: 1,
    OS_DefaultFlags: 2,
    OS_MaterialOverrides: 4,
    OS_FlagOverrides: 8
};

function readDbIdSet(pfr, fn) {
    const count = pfr.readVarint();
    let dbId = 0;
    for (let i = 0; i < count; ++i) {
        const delta = pfr.readVarint();
        dbId += delta;
        fn(dbId);
    }
}

export function readOverrideSet(pfr, entry) {
    const tse = pfr.seekToEntry(entry);
    if (!tse)
        return null;

    const set = {};
    const parts = pfr.stream.getUint32();

    if (parts & OverrideSetParts.OS_DefaultMaterial) {
        set.defaultMaterialIndex = pfr.readVarint();
        set.defaultMaterialFlags = pfr.readU8();
    }

    if (parts & OverrideSetParts.OS_DefaultFlags) {
        set.defaultFlags = pfr.readVarint();
    }

    if (parts & OverrideSetParts.OS_MaterialOverrides) {
        set.materialOverrides = [];
        const count = pfr.readVarint();
        for (let i = 0; i < count; ++i) {
            let matIdx = pfr.readVarint();
            readDbIdSet(pfr, function(dbId) {
                set.materialOverrides.push({
                    dbId: dbId,
                    materialIndex: matIdx
                });
            });
        }
    }

    if (parts & OverrideSetParts.OS_FlagOverrides) {
        set.flagOverrides = [];
        const count = pfr.readVarint();
        for (let i = 0; i < count; ++i) {
            let flags = pfr.readVarint();
            readDbIdSet(pfr, function(dbId) {
                set.flagOverrides.push({
                    dbId: dbId,
                    flags: flags
                });
            });
        }
    }

    return set;
}