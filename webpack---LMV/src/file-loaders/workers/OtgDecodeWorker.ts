import * as OtgGeomCodec from '../lmvtk/otg/OtgGeomCodec';
import { WorkerMain } from './MainWorker';
import { gunzipSync } from 'fflate';

function isGzip(data: Uint8Array) {
    return data[0] === 31 && data[1] === 139;
}

type DecodeWorkerMessage = {
    data:
        | { operation: 'DECODE_GEOMETRIES'; hashes: string[]; arrays: Uint8Array[]; fromCache: boolean[] }
        | { operation: 'DECODE_MATERIALS'; hashes: string[]; arrays: Uint8Array[] };
};

function doInstallInputPort(loadContext: any) {
    loadContext.port.onmessage = (event: DecodeWorkerMessage) => {
        switch (event.data.operation) {
            case 'DECODE_GEOMETRIES':
                doDecodeGeometries(loadContext, event.data.hashes, event.data.arrays, event.data.fromCache);
                break;
            case 'DECODE_MATERIALS':
                doDecodeMaterials(loadContext.worker, event.data.hashes, event.data.arrays);
                break;
        }
    };
}

function doDecodeGeometries(loadContext: any, hashes: string[], arrays: Uint8Array[], fromCaches: boolean[]) {
    const mdatas = new Array<any>();

    for (let i = 0; i < hashes.length; i++) {
        const hash = hashes[i];
        let geom = arrays[i];
        const fromCache = fromCaches[i];

        // If the HTTP fallback was used, the browser already did the decompression
        // Also, we did encounter uncompressed blobs in production.
        if (isGzip(geom)) {
            geom = gunzipSync(geom);
        } else if (geom.byteLength !== geom.buffer.byteLength) {
            // create a copy so the main thread has individual buffers that can be thrown away individually
            geom = geom.slice();
        }

        const mdata = OtgGeomCodec.readLmvBufferGeom(geom) as any;

        if (!mdata) {
            loadContext.raiseError(null, 'Failed to parse geometry', { hash: hash, resourceType: 'g' });
            continue;
        }

        mdata.fromCache = fromCache;
        mdata.hash = hash;
        mdatas.push(mdata);
    }

    const transferList = new Array<ArrayBuffer>();
    for (const mdata of mdatas) {
        const mesh = mdata.mesh;
        if (mesh) {
            const b = mesh.vb.buffer;
            transferList.push(b);

            if (mesh.indices && mesh.indices.buffer !== b) {
                transferList.push(mesh.indices.buffer);
            }
            if (mesh.iblines && mesh.iblines.buffer !== b) {
                transferList.push(mesh.iblines.buffer);
            }
        }
    }
    loadContext.worker.postMessage(mdatas, transferList);
}

function doDecodeMaterials(worker: Worker, hashes: string[], arrays: Uint8Array[]) {
    const out = new Array<Uint8Array>();
    for (let i = 0; i < hashes.length; i++) {
        let data = arrays[i];

        if (isGzip(data)) {
            data = gunzipSync(data);
        } else if (data.byteLength !== data.buffer.byteLength) {
            // create a copy so the main thread has individual buffers that can be thrown away individually
            data = data.slice();
        }
        out.push(data);
    }
    worker.postMessage(
        { materials: out, hashes: hashes },
        out.map((e) => e.buffer)
    );
}

export function register(workerMain: WorkerMain) {
    workerMain.register('INSTALL_INPUT_PORT', { doOperation: doInstallInputPort });
}
