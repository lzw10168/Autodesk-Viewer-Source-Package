import {
    Path2D
} from "./path2d";

var av = Autodesk.Viewing,
    avp = av.Private;

const VertexBufferBuilder = avp.VertexBufferBuilder;

//Custom implementation of HTML Canvas API used for rendering PDF geometry using the WebGL accelerated F2D renderer


//A custom context object that overloads standard HMTL Canvas 2D context to intercept draw
//calls and pipe them into LMV vertex buffers
export function hijackContextAPI(inContext, lmvContext) {

    let fnList = [
        "fillRect",
        "strokeRect",
        "clearRect",
        "beginPath",
        "closePath",
        "moveTo",
        "lineTo",
        "arc",
        "arcTo",
        "quadraticCurveTo",
        "bezierCurveTo",
        "rect",
        "fill",
        "stroke",
        "clip",
        "strokeText",
        "fillText",
        "drawImage",
        "save",
        "restore",
        "setLineDash",
        "createPattern",

        // OCG related
        "beginMarkedContent",
        "beginMarkedContentProps",
        "endMarkedContent",
        "setCurrentOperatorIndex",

        "isLMVCanvasContext",

        // subgroups
        "beginChildGroup",
        "endChildGroup"
    ];

    fnList.forEach(fn => {
        inContext["_original" + fn] = inContext[fn];
        inContext[fn] = lmvContext[fn].bind(lmvContext);
    });

}

const QUAD_TEXTURE = 1;
const IMAGE_TEXTURE = 2;

let _tmpXform = new Array(6);
let _tmpVec = new THREE.Vector2();
let _tmpBox = new THREE.Box2();


//Used for matrix decomposition in drawImage
var _offset = new THREE.Vector3();
var _quat = new THREE.Quaternion();
var _scale = new THREE.Vector3();
var _axis = new THREE.Vector3();
var _mtx4 = new THREE.Matrix4();

export class LmvCanvasContext {

    static getLayerKey(properties) {
        let key;
        if (properties && typeof(properties) == "object") {
            key = properties.ocgId;
            // some PDFs have a missing ocgId, as in https://jira.autodesk.com/browse/BLMV-8395
            if (key === undefined) {
                key = properties.name;
            }
        } else {
            key = properties;
        }
        return key;
    }

    /**
     * Check is a PDF Ref object
     * @param {PDF.Ref} obj
     */
    static isRef(obj) {
        return obj != null && typeof(obj.num) === "number" && typeof(obj.gen) === "number";
    }

    /**
     * generate a simple string works as a key for the ref.
     * @param {PDF.Ref} ref
     */
    static refKey(ref) {
        return `${ref.num}-${ref.gen}`;
    }

    // from /@adsk/pdfjs-dist/lib/shared/util.js
    static applyTransform(p, m) {
        const xt = p[0] * m[0] + p[1] * m[2] + m[4];
        const yt = p[0] * m[1] + p[1] * m[3] + m[5];
        return [xt, yt];
    }

    static inverseTransform(m) {
        const d = m[0] * m[3] - m[1] * m[2];
        return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[4] * m[3]) / d, (m[4] * m[1] - m[5] * m[0]) / d];
    }

    constructor(viewport, toPageUnits, meshCallback, fontEngine, usingTextLayer, fontAtlas, pdfRefMap) {

        //
        // Prepare canvas using PDF page dimensions
        //
        //TODO: Do we need that or can we just overload the entire CanvasContext API and skip the HTML element creation completely?
        const _document = av.getGlobal().document;
        var canvas = _document.createElement('canvas');
        var context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        // do not use image smoothing to improve quality of small image sequences
        context.imageSmoothingEnabled = false;

        this.canvasContext = context; //REQUIRED for PDF.js interface
        this.viewport = viewport; //REQUIRED for PDF.js interface
        this.toPageUnits = toPageUnits;

        this.meshCallback = meshCallback;
        // Only set bounds for PDF, because Edit2d is using LmvCanvasContext for drawing, and doesn't require clipping
        if (viewport.clipToViewport == true) {
            let offsetX = viewport.offsetX || 0;
            let offsetY = viewport.offsetY || 0;
            this.bounds = new THREE.Vector4(offsetX * toPageUnits, offsetY * toPageUnits,
                (viewport.width + offsetX) * toPageUnits, (viewport.height + offsetY) * toPageUnits);
        }

        this.currentMeshIndex = 0;
        this.imageNumber = 0;
        this.currentVbb = new VertexBufferBuilder(false);
        this._curPath = null;
        this._curClip = null;
        this.first = true;
        this.states = [];
        this.glyphCache = {};
        this.usingTextLayer = usingTextLayer;

        //Fixed precision tolerance assuming the input is in typographic "point" units.
        this.precisionTolerance = 0.1;

        this.dbId = -1;
        this.maxDbId = 0;

        // If true, dbId is automatically increased on each beginPath call.
        this.consecutiveIds = false;

        if (av.isMobileDevice()) {
            Autodesk.Extensions.CompGeom.SetTesselationParams(undefined, 0.1);
        }

        this.fontEngine = fontEngine;

        // Use solid lines by default. See LineStyleDef.js for other line types (dashed etc.)
        this.lineStyle = 0;

        // If true, lines widths are applied in screen-space
        this.isScreenSpace = false;

        hijackContextAPI(context, this);

        this.layers = {};
        this.defaultLayerId = 0;
        this.currentLayerId = this.defaultLayerId;
        this.sequencedDbId = -1;
        this.taggedId = null;
        this.defaultVPId = 0;
        this.viewportCounter = 1;
        this.currentVpId = this.defaultVPId;
        this.viewports = [this.createViewPortData(
            new THREE.Matrix4().makeScale(viewport.scale, viewport.scale, viewport.scale).elements
        )];
        this.viewportMap = {};

        this.ocgStack = [];

        this.msdfRender = true;
        this.fontAtlas = fontAtlas;
        this.pdfRefMap = pdfRefMap || {};

        this.smallImageSequenceToCheck = -1;
        this.inSmallImageRendering = false;

        this.inChildGroup = false;
        this.overrideCompositeOperation = 'source-over';
        this.overrideAlpha = 1.0;
    }

    destroy() {
        this.canvasContext = null;
        this.meshCallback = null;
    }

    updateDBId() {
        if (this.taggedId != null) {
            this.dbId = this.taggedId;
        } else {
            if (this.consecutiveIds) {
                this.sequencedDbId++;
                this.dbId = this.sequencedDbId;
            }
        }

        this.maxDbId = Math.max(this.maxDbId, this.dbId);
    }

    snapToPixel(x, y) {
        const invM = this.canvasContext.mozCurrentTransformInverse;
        const m = this.canvasContext.mozCurrentTransform;

        let p = LmvCanvasContext.applyTransform([x, y], m);
        p[0] = Math.round(p[0]);
        p[1] = Math.round(p[1]);
        return LmvCanvasContext.applyTransform(p, invM);
    }

    save() {
        //console.log("save");
        this.states.push({
            clip: this._curClip,
            consecutiveIds: this.consecutiveIds,
            lineDashedDef: this.lineDashedDef,
            lineStyle: this.lineStyle,
            overrideCompositeOperation: this.overrideCompositeOperation,
            overrideAlpha: this.overrideAlpha,
            inChildGroup: this.inChildGroup,
        });

        this.canvasContext._originalsave();
    }

    restore() {

        let state = this.states.pop();

        if (state) {
            this._curClip = state.clip;
            this.consecutiveIds = state.consecutiveIds;
            this.lineDashedDef = state.lineDashedDef;
            this.lineStyle = state.lineStyle;
            this.overrideCompositeOperation = state.overrideCompositeOperation;
            this.overrideAlpha = state.overrideAlpha;
            this.inChildGroup = state.inChildGroup;
        }

        //console.log("restore");
        this.canvasContext._originalrestore();
    }

    flushBuffer(addCount, finalFlush, textureOption) {
        if (!this.currentVbb.vcount && !finalFlush) {
            return;
        }

        // LMV-5542 - support blend modes for fill colors
        // Limit the number of times that meshes are split up.
        // When adding support for a new compositeOperation, add it to the if condition.
        let compositeOperation = 'source-over';
        // ToDo: how to handle multiple composite operations? For now, an override with 'source-over' is ignored, any other override wins. See also beginChildGroup().
        const globalCompOp = this.overrideCompositeOperation != 'source-over' ? this.overrideCompositeOperation : this.canvasContext.globalCompositeOperation;
        if (globalCompOp === 'multiply' || globalCompOp === 'min' || globalCompOp === 'darken' || globalCompOp === 'lighten') {
            compositeOperation = globalCompOp;
        }

        // When the blending mode has changed, we have to flush the shapes that were added with the blending mode that
        // was current until now, that's why we use this.currentCompositeOperation below when setting material.compositeOperation.
        const blendModeChanged = this.currentCompositeOperation !== compositeOperation;
        const flush = finalFlush || this.currentVbb.isFull(addCount) || blendModeChanged;

        if (flush) {
            if (this.currentVbb.vcount) {
                const mesh = this.currentVbb.toMesh();
                mesh.material = {
                    skipEllipticals: !this.currentVbb.numEllipticals,
                    skipCircles: !this.currentVbb.numCirculars,
                    skipTriangleGeoms: !this.currentVbb.numTriangleGeoms,
                    skipMiterLines: !this.currentVbb.numMiterLines,
                    useInstancing: this.currentVbb.useInstancing,
                    isScreenSpace: !this.currentImage,
                    hasLineStyles: this.currentVbb.hasLineStyles,
                    msdfFontTexture: !!this.hasMSDFContent,
                    viewportBounds: this.bounds,
                    imageUVTexture: textureOption === IMAGE_TEXTURE
                };

                if (this.currentImage) {
                    mesh.material.image = this.currentImage;
                    mesh.material.image.name = this.currentImage.cacheKey || this.imageNumber++;
                    // Assume the background of PDF page is white, when use it to do multiply, white is better then black color
                    // And it should be correct for most cases
                    mesh.material.compositeCanvasColor = "#ffffff";
                    mesh.material.opacity = this.canvasContext.globalAlpha;
                    this.currentImage = null;
                }

                mesh.material.compositeOperation = this.currentCompositeOperation;
                // LMV-5840: Apply the global alpha to the meshes in the group.
                if (this.inChildGroup && mesh.material.opacity !== this.overrideAlpha) {
                    mesh.material.hasOpacity = !!this.overrideAlpha;
                    mesh.material.opacity = this.overrideAlpha;
                }

                this.meshCallback(mesh, this.currentMeshIndex++);
                this.currentVbb.reset(0);
                this.hasMSDFContent = false;
            }
        }

        this.currentCompositeOperation = compositeOperation;
    }

    //Polytriangle requires some post-processing depending on wheter instancing is used or not
    //TODO: This is copy-pasted from the same function in F2D.js. It's purely used to
    //add half width outline to polytriangles so that they look antialiased.
    addPolyTriangle(points, inds, color, dbId, layer, antialiasEdges) {
        var me = this;
        var edgeMap = null;

        var currentVpId = this.currentVpId;

        var aaLineWeight = -0.5; //negative = in pixel units

        function processEdge(iFrom, iTo) {
            if (iFrom > iTo) {
                var tmp = iFrom;
                iFrom = iTo;
                iTo = tmp;
            }

            if (!edgeMap[iFrom])
                edgeMap[iFrom] = [iTo];
            else {
                var adjacentVerts = edgeMap[iFrom];
                var idx = adjacentVerts.lastIndexOf(iTo);
                if (idx == -1)
                    adjacentVerts.push(iTo); //first time we see this edge, so remember it as exterior edge
                else
                    adjacentVerts[idx] = -1; //the second time we see an edge mark it as interior edge
            }
        }


        function addAllAntialiasEdges() {

            for (var i = 0, iEnd = edgeMap.length; i < iEnd; i++) {

                var adjacentVerts = edgeMap[i];
                if (!adjacentVerts)
                    continue;

                for (var j = 0; j < adjacentVerts.length; j++) {
                    var iTo = adjacentVerts[j];
                    if (iTo == -1)
                        continue; //an interior edge was here -- skip
                    else {
                        //exterior edge -- add an antialiasing line for it
                        me.flushBuffer(4);
                        me.currentVbb.addSegment(points[2 * i], points[2 * i + 1],
                            points[2 * iTo], points[2 * iTo + 1],
                            me.currentLayerId,
                            aaLineWeight,
                            color,
                            dbId, layer, currentVpId, me.lineStyle);
                    }
                }
            }
        }

        function antialiasOneEdge(iFrom, iTo) {
            if (iFrom > iTo) {
                var tmp = iFrom;
                iFrom = iTo;
                iTo = tmp;
            }

            var adjacentVerts = edgeMap[iFrom];
            if (!adjacentVerts)
                return;

            var idx = adjacentVerts.indexOf(iTo);
            if (idx != -1) {
                //exterior edge -- add an antialiasing line for it
                me.flushBuffer(4);
                me.currentVbb.addSegment(points[2 * iFrom], points[2 * iFrom + 1],
                    points[2 * iTo], points[2 * iTo + 1],
                    me.currentLayerId,
                    aaLineWeight,
                    color,
                    dbId, layer, currentVpId, me.lineStyle);
            }
        }

        if (antialiasEdges) {
            edgeMap = new Array(points.length / 2);

            for (var i = 0, iEnd = inds.length; i < iEnd; i += 3) {
                var i0 = inds[i];
                var i1 = inds[i + 1];
                var i2 = inds[i + 2];

                processEdge(i0, i1);
                processEdge(i1, i2);
                processEdge(i2, i0);
            }
        }

        if (isNaN(color) && (color.isPattern === true || color.imageTransform)) {
            this.flushBuffer(0, true);
            var image = color.image;
            var count = points.length / 2; // number of vertices

            this.flushBuffer(count);
            var vbb = this.currentVbb;
            var vbase = vbb.vcount;

            // need to apply the transformation to the UV
            var xform = this.getCurrentTransform();

            //LMV-5353
            if (color.repetition === "no-repeat" && !color.isGradient) {
                const x1 = this.tx(0, 0, xform);
                const y1 = this.ty(0, 0, xform);
                const x2 = this.tx(image.width, image.height, xform);
                const y2 = this.ty(image.width, image.height, xform);
                vbb.addVertexImagePolytriangle(x1, y1, 0, 0, 0xFFFFFFFF, dbId, layer, currentVpId);
                vbb.addVertexImagePolytriangle(x1, y2, 0, -1, 0xFFFFFFFF, dbId, layer, currentVpId);
                vbb.addVertexImagePolytriangle(x2, y2, 1, -1, 0xFFFFFFFF, dbId, layer, currentVpId);
                vbb.addVertexImagePolytriangle(x2, y1, 1, 0, 0xFFFFFFFF, dbId, layer, currentVpId);

                inds = [0, 1, 2, 0, 2, 3];
            } else if (color.imageTransform) {
                for (let i = 0; i < count; ++i) {
                    var x = points[2 * i];
                    var y = points[2 * i + 1];

                    const uv = LmvCanvasContext.applyTransform([x, y], color.imageTransform);

                    vbb.addVertexImagePolytriangle(x, y, uv[0], uv[1], 0xFFFFFFFF, dbId, layer, currentVpId);
                }
            } else {
                for (let i = 0; i < count; ++i) {
                    const x = points[2 * i];
                    const y = points[2 * i + 1];

                    let u, v;
                    if (color.isGradient) {
                        const x1 = this._curPath.bbox.min.x;
                        const y1 = this._curPath.bbox.min.y;
                        const w1 = this._curPath.bbox.max.x - x1;
                        const h1 = this._curPath.bbox.max.y - y1;

                        u = (x - x1) / w1;
                        v = (y - y1) / h1;
                    } else {
                        const uv = LmvCanvasContext.applyTransform([x / this.toPageUnits, y / this.toPageUnits], this.getCurrentInverseTransform());

                        u = uv[0] / image.width;
                        v = uv[1] / image.height;
                    }


                    vbb.addVertexImagePolytriangle(x, y, u, 1 - v, 0xFFFFFFFF, dbId, layer, currentVpId);
                }
            }

            this.currentImage = image;
            vbb.addIndices(inds, vbase);
            this.flushBuffer(0, true, IMAGE_TEXTURE);
        } else {
            if (this.currentVbb.useInstancing) {
                const count = inds.length;
                for (let i = 0; i < count; i += 3) {
                    let i0 = inds[i];
                    let i1 = inds[i + 1];
                    let i2 = inds[i + 2];
                    this.flushBuffer(4);

                    this.currentVbb.addTriangleGeom(points[2 * i0], points[2 * i0 + 1],
                        points[2 * i1], points[2 * i1 + 1],
                        points[2 * i2], points[2 * i2 + 1],
                        color, dbId, layer, currentVpId);

                    if (antialiasEdges) {
                        antialiasOneEdge(i0, i1);
                        antialiasOneEdge(i1, i2);
                        antialiasOneEdge(i2, i0);
                    }
                }
            } else {
                const count = points.length / 2; // number of vertices
                this.flushBuffer(count);
                const vbb = this.currentVbb;
                const vbase = vbb.vcount;

                for (let i = 0; i < count; ++i) {
                    const x = points[2 * i];
                    const y = points[2 * i + 1];
                    vbb.addVertexPolytriangle(x, y, color, dbId, layer, currentVpId);
                }

                vbb.addIndices(inds, vbase);

                if (antialiasEdges) {
                    addAllAntialiasEdges();
                }

            }
        }
    }

    /**
     * Returns a new GradientData instance.
     * @param {Object} data - contains the raw data to create the GradientData.
     * @returns {GradientData}
     */
    createGradientData(data) {
        return new GradientData(data);
    }

    //Extract colors from HTML Canvas state
    getFillColor() {
        // Create a pattern from a CanvasGradient
        const getGradientFill = (gradientData) => {

            const startPoint = gradientData.startPoint.slice();
            const endPoint = gradientData.endPoint.slice();

            // according to the PDF spec, the gradient points are in shape space
            // so apply the current transform to the gradient points
            const xform = this.getCurrentTransform();
            const sp0 = startPoint[0];
            const ep0 = endPoint[0];
            startPoint[0] = this.tx(sp0, startPoint[1], xform);
            startPoint[1] = this.ty(sp0, startPoint[1], xform);
            endPoint[0] = this.tx(ep0, endPoint[1], xform);
            endPoint[1] = this.ty(ep0, endPoint[1], xform);

            // build a canvas that is the size of the path's bounding box at a reasonable resolution
            const scale = this.viewport.scale || 1;
            let toCanvas = 1.0 / this.toPageUnits / scale;
            let width = (this._curPath.bbox.max.x - this._curPath.bbox.min.x) * toCanvas;
            let height = (this._curPath.bbox.max.y - this._curPath.bbox.min.y) * toCanvas;

            // limit the size of the canvas to save memory
            const CANVAS_SIZE_LIMIT = 2048;
            const maxDim = Math.max(width, height);
            if (maxDim > CANVAS_SIZE_LIMIT) {
                toCanvas *= CANVAS_SIZE_LIMIT / maxDim;
                // repeat the transform with the new scale
                width = (this._curPath.bbox.max.x - this._curPath.bbox.min.x) * toCanvas;
                height = (this._curPath.bbox.max.y - this._curPath.bbox.min.y) * toCanvas;
            }

            // map the gradient from shape space into the path bbox
            // subtract the bounding box min point
            const offsetX = this._curPath.bbox.min.x;
            const offsetY = this._curPath.bbox.min.y;
            startPoint[0] -= offsetX;
            startPoint[1] -= offsetY;
            endPoint[0] -= offsetX;
            endPoint[1] -= offsetY;

            // scale the gradient to the size of the canvas
            startPoint[0] *= toCanvas;
            startPoint[1] *= toCanvas;
            endPoint[0] *= toCanvas;
            endPoint[1] *= toCanvas;

            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = width;
            tempCanvas.height = height;

            const tempCtx = tempCanvas.getContext('2d');
            // Create the gradient with the paths bounding box offset applied
            // var gradient = createGradient(tempCtx, gradientData);
            const gradient = gradientData.generateCanvasGradient(tempCtx, startPoint, endPoint);
            tempCtx.fillStyle = gradient;
            tempCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

            const pattern = this.createPattern(tempCanvas, 'no-repeat');
            pattern.isGradient = true;
            return pattern;
        };


        const fillStyle = this.canvasContext.fillStyle;
        if (fillStyle && fillStyle.isPattern === true) {
            return fillStyle;
        } else if (fillStyle instanceof CanvasGradient) {
            const gradientData = new GradientData(fillStyle);
            return getGradientFill(gradientData);
        } else if (typeof fillStyle !== "string") {
            console.warn("Unsupported fill style.");
            return 0x00000000;
        }

        var rgb = parseInt(fillStyle.slice(1), 16);
        var a = (255 * this.canvasContext.globalAlpha) << 24;
        var c = a | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
        return c;
    }

    getStrokeColor() {

        let ctx = this.canvasContext;

        if (this.lastStrokeStyle === ctx.strokeStyle && ctx.globalAlpha === this.lastAlpha) {
            return this.lastRgb;
        } else {
            let rgb;
            if (typeof ctx.strokeStyle !== "string") {
                console.warn("Unsupported stroke style.");
                rgb = parseInt(0x00000000, 16);
            } else {
                rgb = parseInt(ctx.strokeStyle.slice(1), 16);
            }
            var a = (255 * ctx.globalAlpha) << 24;
            var c = a | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);

            this.lastRgb = c;
            this.lastStrokeStyle = ctx.strokeStyle;
            this.lastAlpha = ctx.globalAlpha;

            return c;
        }

    }

    getCurrentTransform() {
        let xform = this.canvasContext.mozCurrentTransform;

        //Pay attention here: In case we are processing the path of a character and we want to
        //cache it for later use, we have to neutralize the part of the canvas transform that positions
        //the character in the page, but we need to keep the rest of the transform (that positions parts
        //of the character in its own em-box). This is what the inverse transform multiplication here does.
        //TODO: we can optimize this to only compute the multiplication in case mozCurrentTransform changes.
        if (this.isFontChar) {
            let m = this.invXform;
            let a = xform[0],
                b = xform[1],
                c = xform[2],
                d = xform[3],
                e = xform[4],
                f = xform[5];
            _tmpXform[0] = m[0] * a + m[2] * b;
            _tmpXform[1] = m[1] * a + m[3] * b;
            _tmpXform[2] = m[0] * c + m[2] * d;
            _tmpXform[3] = m[1] * c + m[3] * d;
            _tmpXform[4] = m[0] * e + m[2] * f + m[4];
            _tmpXform[5] = m[1] * e + m[3] * f + m[5];
            return _tmpXform;
        }
        return xform;
    }

    getCurrentInverseTransform() {
        return this.canvasContext.mozCurrentTransformInverse;
    }

    tx(x, y, xform) {
        xform = xform || this.getCurrentTransform();
        return (x * xform[0] + y * xform[2] + xform[4]) * (this.isFontChar ? 1 : this.toPageUnits);
    }

    ty(x, y, xform) {
        xform = xform || this.getCurrentTransform();
        return (x * xform[1] + y * xform[3] + xform[5]) * (this.isFontChar ? 1 : this.toPageUnits);
    }

    scaleValue(v, xform) {
        xform = xform || this.getCurrentTransform();
        return this.toPageUnits * Math.sqrt(Math.abs(xform[0] * xform[3] - xform[1] * xform[2])) * v; //assumes uniform;
    }

    transformBox(bbox, xform, dst) {
        xform = xform || this.getCurrentTransform();

        _tmpBox.makeEmpty();

        _tmpVec.set(this.tx(bbox.min.x, bbox.min.y, xform), this.ty(bbox.min.x, bbox.min.y, xform));
        _tmpBox.expandByPoint(_tmpVec);

        _tmpVec.set(this.tx(bbox.max.x, bbox.min.y, xform), this.ty(bbox.max.x, bbox.min.y, xform));
        _tmpBox.expandByPoint(_tmpVec);

        _tmpVec.set(this.tx(bbox.max.x, bbox.max.y, xform), this.ty(bbox.max.x, bbox.max.y, xform));
        _tmpBox.expandByPoint(_tmpVec);

        _tmpVec.set(this.tx(bbox.min.x, bbox.max.y, xform), this.ty(bbox.min.x, bbox.max.y, xform));
        _tmpBox.expandByPoint(_tmpVec);

        if (dst) {
            dst.copy(_tmpBox);
            return dst;
        } else {
            return _tmpBox.clone();
        }
    }


    fillRect(x, y, w, h) {
        if (this.inSmallImageRendering) {
            // Snap the rectangle to whole pixel dimensions in order to avoid antialiasing
            const p1 = this.snapToPixel(x, y);
            const p2 = this.snapToPixel(x + w, y + h);
            const wS = p2[0] - p1[0];
            const hS = p2[1] - p1[1];
            this.canvasContext._originalfillRect(p1[0], p1[1], wS, hS);
            return;
        }

        this.updateDBId();

        // Hack: Assumption here is that the first fillRect call is for the white background quad.
        //       For this, we don't want a dbI and use -1 instead. Unfortunately, this fillRect call happens
        //       inside PDF.js (see beginDrawing in display/canvas.js), so we cannot easily set this id from outside.
        this.rect(x, y, w, h);

        this.dbId = this.first ? -1 : this.dbId;
        this.first = false;
        this.fill();
        this.beginPath();
    }

    strokeRect(x, y, w, h) {
        //TODO:
        console.log("strokeRect");
    }

    clearRect(x, y, w, h) {
        console.log("clearRect");
        //TODO:
    }

    _beginTextChar(character, x, y, font, fontSize) {
        this.isFontChar = true;
        this.invXform = this.canvasContext.mozCurrentTransformInverse;
        this.hashKey = character.codePointAt(0) + "/" + font.loadedName + "/" + fontSize;
        this.cachedGlyph = this.glyphCache[this.hashKey];

        if (this.cachedGlyph) {
            this.skipPath = true;
        } else {
            this.skipPath = false;
        }
        //console.log(character, x, y, font, fontSize);
    }

    drawMSDFText(character, scaleX, scaleY, font, fontSize) {
        scaleX = 0;
        var fontName = font.name;

        function distance(x0, y0, x1, y1, x2, y2) {
            return Math.abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / Math.sqrt((y2 - y1) * (y2 - y1) + (x2 - x1) * (x2 - x1));
        }

        if (this.fontAtlas && this.fontAtlas.charsMap && this.fontAtlas.charsMap[fontName]) {
            var charIndex = this.fontAtlas.charsMap[fontName][character.charCodeAt(0)];
            if (charIndex == undefined) {
                return false;
            } else {
                if (this.currentVbb.isFull(4)) {
                    this.flushBuffer(0, true);
                }

                this.hasMSDFContent = true;
                var char = this.fontAtlas.chars[charIndex];
                if (char.page > 0) {
                    // Now only support 1 page of font texture, need to add extra logic for multiple font texture in the shader pipeline
                    return false;
                }
                var common = this.fontAtlas.common[char.common];
                var info = this.fontAtlas.info[char.info];

                // need to consider the font size
                var scale = fontSize / info.size;
                var w = char.width * (scale + scaleX);
                let flag = char.inverseYAxis ? -1 : 1;
                var h = char.height * (scale + scaleY) * flag;
                var x = char.txoffset * (scale + scaleX),
                    y = char.tyoffset * (scale + scaleY) * (-flag);

                var points = [
                    x, y,
                    x, y + h,
                    x + w, y + h,
                    x + w, y
                ];

                var ps = [];
                for (let i = 0; i < points.length; i += 2) {
                    ps.push(this.tx(points[i], points[i + 1]));
                    ps.push(this.ty(points[i], points[i + 1]));
                }
                let uv = [];

                if (char.inverseYAxis) {
                    uv = [
                        char.x / common.scaleW, 1 - char.y / common.scaleH,
                        char.x / common.scaleW, 1 - (char.y + char.height) / common.scaleH,
                        (char.x + char.width) / common.scaleW, 1 - (char.y + char.height) / common.scaleH,
                        (char.x + char.width) / common.scaleW, 1 - char.y / common.scaleH,
                    ];
                } else {
                    uv = [
                        char.x / common.scaleW, 1 - (char.y + char.height) / common.scaleH,
                        char.x / common.scaleW, 1 - char.y / common.scaleH,
                        (char.x + char.width) / common.scaleW, 1 - char.y / common.scaleH,
                        (char.x + char.width) / common.scaleW, 1 - (char.y + char.height) / common.scaleH,
                    ];
                }

                // do a fast clipping for MSDF text, if the text is clipped out any part, will not show the text to make it simple
                // otherwise it requires to do a whole UV mapping for each part left, which is overhead at this moment.
                if (this._curClip) {
                    var path = new Path2D(this.precisionTolerance);
                    let index = 0;
                    path.moveTo(ps[index++], ps[index++]);
                    path.lineTo(ps[index++], ps[index++]);
                    path.lineTo(ps[index++], ps[index++]);
                    path.lineTo(ps[index++], ps[index++]);
                    path.closePath();

                    var subjFlatted = path.flattened || path.flatten(true);
                    var clipFlatted = this._curClip.flattened || this._curClip.flatten(true);
                    var precheckResult = path.preCheckForClipping(this, clipFlatted, subjFlatted, false, false);
                    if (precheckResult.needClipping) {
                        var polygons = path.msdfClipping(clipFlatted);
                        let x1 = ps[0],
                            y1 = ps[1];
                        let x2 = ps[6],
                            y2 = ps[7];
                        let x3 = ps[2],
                            y3 = ps[3];

                        let w1 = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
                        let h1 = Math.sqrt((x3 - x1) * (x3 - x1) + (y3 - y1) * (y3 - y1));
                        // need to get the corresponding UV value
                        for (var j = 0; j < polygons.length; j++) {
                            let polygon = polygons[j];
                            if (this.currentVbb.isFull(polygon.vertices.length)) {
                                this.flushBuffer(0, true);
                            }
                            let vbase = this.currentVbb.vcount;
                            for (var i = 0; i < polygon.vertices.length; i += 2) {
                                let x0 = polygon.vertices[i];
                                let y0 = polygon.vertices[i + 1];
                                let dy = distance(x0, y0, x1, y1, x2, y2);
                                let dx = distance(x0, y0, x1, y1, x3, y3);

                                let u = uv[0] + (uv[4] - uv[0]) * (dx / w1);
                                let v = uv[1] + (uv[5] - uv[1]) * (dy / h1);
                                this.currentVbb.addVertexMSDFPolytriangle(x0, y0, u, v, this.getFillColor(), this.dbId, this.currentLayerId, 0);
                            }
                            this.currentVbb.addIndices(polygon.indices, vbase);
                        }

                        this.currentImage = this.fontAtlas.pages[char.page];
                        return true;
                    } else if (precheckResult.needCancel) {
                        return true;
                    }
                }

                if (this.currentVbb.isFull(4)) {
                    this.flushBuffer(0, true);
                }
                let vbase = this.currentVbb.vcount;
                var count = points.length / 2;
                for (let i = 0; i < count; i++) {
                    this.currentVbb.addVertexMSDFPolytriangle(ps[i * 2], ps[i * 2 + 1], uv[i * 2], uv[i * 2 + 1], this.getFillColor(), this.dbId, this.currentLayerId, 0);
                }

                this.currentVbb.addIndices([0, 2, 1, 0, 2, 3], vbase);
                this.currentImage = this.fontAtlas.pages[char.page];

                return true;
            }

        } else {
            return false;
        }
    }

    beginPath(character, x, y, font, fontSize) {
        if (this.inSmallImageRendering) {
            // ignore text use case
            if (typeof character !== "string") {
                this.canvasContext._originalbeginPath();
            }
            return;
        }

        this.updateDBId();

        if (typeof character === "string" && font && fontSize) {
            if (this.fontAtlas && this.drawMSDFText(character, x, y, font, fontSize)) {
                this.skipPath = true;
            } else {
                if (this.usingTextLayer === true) {
                    this.skipPath = true;
                } else {
                    this._beginTextChar(character, x, y, font, fontSize);
                }
            }
        } else {
            this.skipPath = false;
            this.isFontChar = false;
            this.cachedGlyph = null;
        }

        if (this.skipPath)
            this._curPath = null;
        else {
            this._curPath = new Path2D(this.isFontChar ? 0.0001 : this.precisionTolerance);

            // Apply custom tess params (if specified)
            this._curPath.setTessParams(this.tessParams);
        }
    }

    setMiterLine(isMiterLine) {
        this._curPath.isMiterLine = isMiterLine;
    }

    closePath() {
        if (this.inSmallImageRendering) {
            this.canvasContext._originalclosePath();
            return;
        }


        if (this.skipPath)
            return;

        this._curPath.closePath();
        this.cachedGlyph = null;
    }

    moveTo(x, y) {
        if (this.inSmallImageRendering) {
            // snap to pixel so that axis-aligned rectangles do not trigger antialiasing
            const p = this.snapToPixel(x, y);
            this.canvasContext._originalmoveTo(p[0], p[1]);
            return;
        }


        if (this.skipPath)
            return;

        if (!this._curPath)
            this.beginPath();

        let xform = this.getCurrentTransform();

        this._curPath.moveTo(this.tx(x, y, xform), this.ty(x, y, xform));
    }

    lineTo(x, y) {
        if (this.inSmallImageRendering) {
            // snap to pixel so that axis-aligned rectangles do not trigger antialiasing
            const p = this.snapToPixel(x, y);
            this.canvasContext._originallineTo(p[0], p[1]);
            return;
        }


        if (this.skipPath)
            return;

        let xform = this.getCurrentTransform();

        this._curPath.lineTo(this.tx(x, y, xform), this.ty(x, y, xform));
    }

    arc(x, y, radius, startAngle, endAngle, anticlockwise) {
        if (this.inSmallImageRendering) {
            // forward without special treatment - seems unlikely to be used between image strips
            this.canvasContext._originalarc(x, y, radius, startAngle, endAngle, anticlockwise);
            return;
        }


        if (this.skipPath)
            return;

        //TODO: transform

        this._curPath.arc(x, y, radius, startAngle, endAngle, anticlockwise);
    }

    arcTo(x1, y1, x2, y2, radius) {
        if (this.inSmallImageRendering) {
            // forward without special treatment - seems unlikely to be used between image strips
            this.canvasContext._originalarcTo(x1, y1, x2, y2, radius);
            return;
        }


        if (this.skipPath)
            return;

        let xform = this.getCurrentTransform();

        this._curPath.arcTo(this.tx(x1, y1, xform), this.ty(x1, y1, xform),
            this.tx(x2, y2, xform), this.ty(x2, y2, xform),
            this.scaleValue(radius, xform));
    }

    quadraticCurveTo(cp1x, cp1y, x, y) {
        if (this.inSmallImageRendering) {
            // forward without special treatment - seems unlikely to be used between image strips
            this.canvasContext._originalquadraticCurveTo(cp1x, cp1y, x, y);
            return;
        }


        if (this.skipPath)
            return;

        let xform = this.getCurrentTransform();

        this._curPath.quadraticCurveTo(this.tx(cp1x, cp1y, xform), this.ty(cp1x, cp1y, xform),
            this.tx(x, y, xform), this.ty(x, y, xform));
    }

    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
        if (this.inSmallImageRendering) {
            // forward without special treatment - seems unlikely to be used between image strips
            this.canvasContext._originalbezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y);
            return;
        }


        if (this.skipPath)
            return;

        let xform = this.getCurrentTransform();

        this._curPath.bezierCurveTo(this.tx(cp1x, cp1y, xform), this.ty(cp1x, cp1y, xform),
            this.tx(cp2x, cp2y, xform), this.ty(cp2x, cp2y, xform),
            this.tx(x, y, xform), this.ty(x, y, xform));
    }

    ellipse(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw) {
        if (this.inSmallImageRendering) {
            // forward without special treatment - seems unlikely to be used between image strips
            this.canvasContext._originalellipse(cx, cy, rx, ry, rotation, startAngle, endAngle, ccw);
            return;
        }


        if (this.skipPath) {
            return;
        }

        // TODO: We currently don't use ellipse() with a transform.
        //       The current code only works for translation and uniform scale.
        //       For rotation, startAngle/endAngle would change.
        //       For flipping, ccw may change.
        //       For skew, it gets really fun:
        //        see https://math.stackexchange.com/questions/2068583/when-you-skew-an-ellipse-how-do-you-calculate-the-angle-of-rotation-and-the-new
        let xform = this.getCurrentTransform();

        this._curPath.ellipse(
            this.tx(cx, cy, xform), this.ty(cx, cy, xform),
            this.scaleValue(rx, xform),
            this.scaleValue(ry, xform),
            rotation,
            startAngle,
            endAngle,
            ccw
        );
    }

    rect(x, y, w, h) {
        if (this.inSmallImageRendering) {
            // snap to pixel so that axis-aligned rectangles do not trigger antialiasing
            const p1 = this.snapToPixel(x, y);
            const p2 = this.snapToPixel(x + w, y + h);
            const wS = p2[0] - p1[0];
            const hS = p2[1] - p1[1];
            this.canvasContext._originalrect(p1[0], p1[1], wS, hS);
            return;
        }


        if (this.skipPath)
            return;

        let xform = this.getCurrentTransform();

        if (!this._curPath)
            this.beginPath();

        this._curPath.moveTo(this.tx(x, y, xform), this.ty(x, y, xform));
        this._curPath.lineTo(this.tx(x + w, y, xform), this.ty(x + w, y, xform));
        this._curPath.lineTo(this.tx(x + w, y + h, xform), this.ty(x + w, y + h, xform));
        this._curPath.lineTo(this.tx(x, y + h, xform), this.ty(x, y + h, xform));
        this._curPath.closePath();
    }

    fill(...args) {
        if (this.inSmallImageRendering) {
            // let the original canvas do its job
            if (args.length > 0 && typeof args[0] === "string") {
                // arg[0] is fillrule, ignore possible extra custom arguments
                this.canvasContext._originalfill(args[0]);
            } else {
                // no or only custom arguments
                this.canvasContext._originalfill();
            }
            return;
        }


        //Special flag passed to us by customization in the pdf.js library,
        //telling us to skip the antialiasing for polygons that are both filled and stroked
        let isFillStrokeCombo = false;
        if (args.length) {
            let lastArg = args[args.length - 1];
            if (typeof lastArg === "boolean") {
                isFillStrokeCombo = lastArg;
            }
        }

        if (this.isFontChar && !this.cachedGlyph) {
            this.glyphCache[this.hashKey] = this._curPath;
            this.cachedGlyph = this._curPath;
            this.cachedGlyph.isFontChar = true;
        }

        this.isFontChar = false;

        if (this.cachedGlyph) {
            this.cachedGlyph.fill(this, this.getFillColor(), this.dbId, this.currentLayerId, this._curClip, true);
        } else {
            this._curPath && this._curPath.fill(this, this.getFillColor(), this.dbId, this.currentLayerId, this._curClip, false, isFillStrokeCombo);
        }

        this.skipPath = false;

        //this._curClip = null;
        //lmvContext._curPath = null;
    }

    stroke() {
        if (this.inSmallImageRendering) {
            // let the original canvas do its job
            this.canvasContext._originalstroke();
            return;
        }

        if (this.isFontChar && !this.cachedGlyph) {
            this.glyphCache[this.hashKey] = this._curPath;
            this.cachedGlyph = this._curPath;
            this.cachedGlyph.isFontChar = true;
        }

        this.updateLineDashStyle();
        this.isFontChar = false;

        // LineShader uses negative lineWidths to indicate screen-space line widths. Note that this.canvasContext.lineWidth does not allow negative values.
        // Therefore, we apply the sign separately.
        const sign = this.isScreenSpace ? -1.0 : 1.0;

        if (this.cachedGlyph) {
            this.cachedGlyph.stroke(this, sign * this.scaleValue(this.canvasContext.lineWidth), this.getStrokeColor(), this.dbId, this.currentLayerId, this._curClip, true, this.lineStyle, this.canvasContext.lineCap);
        } else {
            this._curPath && this._curPath.stroke(this, sign * this.scaleValue(this.canvasContext.lineWidth), this.getStrokeColor(), this.dbId, this.currentLayerId, this._curClip, false, this.lineStyle, this.canvasContext.lineCap);
        }

        this.skipPath = false;

        //lmvContext._curPath = null;
    }

    clip(param1, param2) {
        if (this.inSmallImageRendering) {
            // let the original canvas do its job
            this.canvasContext._originalclip(param1);
            return;
        }


        if (param2 !== undefined && param1 !== undefined) {
            this._curClip = param1;
            console.log("Probably unsupported use case");
        } else {

            //The clip region is also affected by any existing clip region,
            //i.e. we have to clip the clip.
            if (this._curClip) {
                this._curClip = this._curClip.clip(this._curPath, param1);
            } else {
                this._curClip = this._curPath;
            }

            this._curPath = null;
        }

        //console.log("CLIP", param1, param2);
    }

    strokeText(text, x, y, maxWidth, font, fontSize) {

        let ctx = this.canvasContext;
        ctx.save();
        ctx.translate(x, y);

        this.fontEngine.drawText(this, text, 0, 0, font, fontSize);
        this.stroke();

        ctx.restore();
    }

    fillText(text, x, y, maxWidth, font, fontSize) {

        let ctx = this.canvasContext;
        ctx.save();
        ctx.translate(x, y);

        this.fontEngine.drawText(this, text, 0, 0, font, fontSize);
        this.fill();
        //this.stroke();

        ctx.restore();
    }

    getRotationAndScale(xform) {
        _mtx4.elements[0] = xform[0];
        _mtx4.elements[1] = xform[1];
        _mtx4.elements[4] = xform[2];
        _mtx4.elements[5] = xform[3];
        _mtx4.elements[12] = xform[4];
        _mtx4.elements[13] = xform[5];
        _mtx4.decompose(_offset, _quat, _scale);

        //Derive the rotation angle by converting the quaternion to axis-angle.
        let s = Math.sqrt(1.0 - _quat.w * _quat.w);
        _axis.set(_quat.x / s, _quat.y / s, _quat.z / s);
        let angle = 2.0 * Math.acos(Math.max(Math.min(1, _quat.w), -1));
        //Take care to negate the angle if the rotation axis is into the page.
        if (_quat.z < 0) {
            angle = -angle;
        }

        //Angle needs to be in the range 0-2pi for use by addTextureQuad below,
        //while input has domain [-pi, pi].
        if (angle < 0) {
            angle += 2 * Math.PI;
        }

        return {
            angle,
            scale: _scale
        };
    }

    drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight) {

        if (this.inSmallImageRendering) {
            let fourParam = false;
            if (dx === undefined) {
                // 2 or 4 param call (drawImage(image, dx, dy) or drawImage(image, dx, dy, dWidth, dHeight))
                // -> move data into the correct variables
                dx = sx;
                dy = sy;
                dWidth = sWidth;
                dHeight = sHeight;
                fourParam = true;
            }

            if (dWidth === undefined) {
                // dWidth still undefined -> 2 param call (drawImage(image, dx, dy))
                // -> move data into the correct variables and fill in image dimensions
                dx = sx;
                dy = sy;
                dWidth = image.width;
                dHeight = image.height;
                // treat it as 4-param call later since we tamper with the dimensions
                fourParam = true;
            }

            const p1 = this.snapToPixel(dx, dy);
            const p2 = this.snapToPixel(dx + dWidth, dy + dHeight);
            const w = p2[0] - p1[0];
            const h = p2[1] - p1[1];
            if (fourParam) {
                this.canvasContext._originaldrawImage(image, p1[0], p1[1], w, h);
            } else {
                this.canvasContext._originaldrawImage(image, sx, sy, sWidth, sHeight, p1[0], p1[1], w, h);
            }
            return;
        }

        let clip = this._curClip;

        if (image.width === 0 || image.height === 0) {
            console.warn("Zero size image, skipping");
            return;
        }

        const xform = this.getCurrentTransform();
        const {
            angle,
            scale
        } = this.getRotationAndScale(xform);

        if (dx === undefined) {
            dx = sx;
            dy = sy;
            dWidth = sWidth;
            dHeight = sHeight;
        }

        if (dWidth === undefined) {
            dWidth = image.width;
            dHeight = image.height;
        }

        if (!dWidth) {
            console.warn("Zero size image, skipping");
            return;
        }

        //console.log("Draw image", dWidth, dHeight);

        if (clip) {
            // if a clipping path is specified we will render the image with the clipping polygon and
            // not with a quad

            const x1 = this.tx(dx, dy);
            const y1 = this.ty(dx, dy);
            const x2 = this.tx(dx + dWidth, dy);
            const y2 = this.ty(dx + dWidth, dy);
            const x3 = this.tx(dx + dWidth, dy + dHeight);
            const y3 = this.ty(dx + dWidth, dy + dHeight);
            const x4 = this.tx(dx, dy + dHeight);
            const y4 = this.ty(dx, dy + dHeight);

            // compute transformation from uv to page space:
            // straight-forward solution without y-flip should read as
            //   const uv2page = [ x2-x1, y2-y1, x4-x1, y4-y1, x1, y1 ];
            // but webgl uvs have [0, 0] at lower left corner while pdf images have [0, 0] at upper left corner
            // pdf.js calls drawImage() with image convention, so the flip needs to get accounted for here:
            // [0, 0] -> [x4, y4]; [1, 0] -> [x3, y3]; [1, 1] -> [x2, y2]; [0, 1] -> [x1, y1]
            const uv2page = [x3 - x4, y3 - y4, x1 - x4, y1 - y4, x4, y4];
            // now invert uv2page to get from page to uv space
            const page2uv = LmvCanvasContext.inverseTransform(uv2page);

            let color = {
                image: image,
                imageTransform: page2uv
            };

            // the clipping path might be larger than the image so we need to clip it with the image quad
            // to avoid repetition
            let imageClip = new Path2D(this.precisionTolerance);
            imageClip.moveTo(x1, y1);
            imageClip.lineTo(x2, y2);
            imageClip.lineTo(x3, y3);
            imageClip.lineTo(x4, y4);
            imageClip.closePath();

            clip.fill(this, color, this.dbId, this.currentLayerId, imageClip, false, false);
        } else {
            //Get the transformed page space image center
            let cx = this.tx(dx + dWidth / 2, dy + dHeight / 2);
            let cy = this.ty(dx + dWidth / 2, dy + dHeight / 2);

            //Get scaled width/height. Note these scalings can result in negative numbers
            let w = dWidth * scale.x * this.toPageUnits;
            let h = -dHeight * scale.y * this.toPageUnits; //Image input is y-down, so we build in a y-inversion

            this.flushBuffer(0, true);
            this.currentVbb.addTexturedQuad(cx, cy, w, h, angle, 0xffff00ff, 0, this.currentLayerId, 0);
            this.currentImage = image;
            this.flushBuffer(0, true, QUAD_TEXTURE);
        }
    }

    /**
     * Mapping back the reference object to its value, and loop 1 level in
     * @param {Object} properties
     */
    _processProperties(properties) {
        if (LmvCanvasContext.isRef(properties)) {
            properties = this.pdfRefMap[LmvCanvasContext.refKey(properties)];
        }

        for (let key in properties) {
            if (LmvCanvasContext.isRef(properties[key])) {
                properties[key] = this.pdfRefMap[LmvCanvasContext.refKey(properties[key])];
            }
        }
        return properties;
    }

    beginMarkedContent(properties) {
        if (properties) {
            properties = this._processProperties(properties);
        }

        // Revit will provided tag as number
        let tag = properties.name || properties.DBID;
        if (!isNaN(tag)) {
            this.taggedId = parseInt(tag);
        } else {
            this.taggedId = null;
        }

        if (this.taggedId !== null && this.dbId !== this.taggedId) {
            this.updateDBId();
        }

        if (properties.VP)
            this.currentVpId = this.viewportCounter++;

        this.ocgStack.push({
            taggedId: this.taggedId,
            viewPortId: this.currentVpId
        });
    }

    beginMarkedContentProps(tag, properties) {
        if (properties) {
            properties = this._processProperties(properties);
        }

        if (tag === "OC") {
            var layerId = this.layers[LmvCanvasContext.getLayerKey(properties)];
            if (layerId === undefined) {
                // VIZX-219: continue to use current layer if the layer is not found
                layerId = this.currentLayerId;
            }
            this.currentLayerId = layerId;

            this.ocgStack.push({
                layerId: this.currentLayerId,
            });
        } else {
            if (!isNaN(tag)) {
                this.taggedId = parseInt(tag);
                if (this.dbId !== this.taggedId) {
                    this.updateDBId();
                }
            }
            if (properties) {
                if (properties.VP)
                    this.currentVpId = this.viewportCounter++;

                this.ocgStack.push({
                    viewPortId: this.currentVpId,
                    taggedId: this.taggedId,
                });
            } else {
                this.ocgStack.push({});
            }
        }
    }

    endMarkedContent() {
        if (this.ocgStack.length > 0) {
            this.ocgStack.pop();
        }

        const findLast = (key) => {
            for (let i = this.ocgStack.length - 1; i >= 0; --i) {
                if (key in this.ocgStack[i]) {
                    return this.ocgStack[i][key];
                }
            }
            return null;
        };

        // Assign last used layer, taggedId and vpId
        let prevLayerId = findLast('layerId');
        let prevVpId = findLast('viewPortId');
        let prevTaggedId = findLast('taggedId');

        this.currentLayerId = (prevLayerId !== null) ? prevLayerId : this.defaultLayerId;
        this.currentVpId = (prevVpId !== null) ? prevVpId : this.defaultVPId;
        let tagChanged = prevTaggedId !== this.taggedId;
        this.taggedId = prevTaggedId;
        if (tagChanged) {
            this.updateDBId();
        }
    }

    setLineStyleParam(param) {
        if (!this.lineStyleInitialized) {
            // Add those default definition in, to keep the app constent.
            let exH = avp.LineStyleDefs.length;
            let exW = 1;
            for (var i = 0; i < avp.LineStyleDefs.length; i++) {
                exW = Math.max(avp.LineStyleDefs[i].def.length, exW);
            }

            let {
                tex,
                pw,
                lineStyleTex
            } = avp.createLinePatternTextureData(Math.max(param.width, exW), param.height + exH + 1);
            this.lineStyleIndex = 0;
            this.lineStylePw = pw;
            this.lineStyleTexData = tex;
            this.lineStyleTexture = lineStyleTex;
            this.lineStyleIndexMap = {};

            for (let i = 0; i < avp.LineStyleDefs.length; i++) {
                this.addNewDashedLineStyle(avp.LineStyleDefs[i], 96);
            }

            // set the default value
            this.lineStyle = 0;
            this.lineStyleInitialized = true;
        }
    }

    addNewDashedLineStyle(ls, dpi) {
        let key = ls.def.join("/");
        if (this.lineStyleIndexMap[key] != undefined) {
            return this.lineStyleIndexMap[key];
        } else {
            avp.createLinePatternForDef(ls, this.lineStyleTexData, this.lineStyleIndex, this.lineStylePw, dpi);
            let index = this.lineStyleIndex;
            this.lineStyleIndexMap[key] = index;
            this.lineStyleIndex++;

            return index;
        }
    }

    setLineDash(def) {
        if (!this.lineStyleInitialized) {
            this.setLineStyleParam({
                width: 5,
                height: 4
            });
        }

        this.lineDashedDef = def;
    }

    createPattern(image, repetition) {
        var pattern = this.canvasContext._originalcreatePattern(image, repetition);
        pattern.image = image;
        pattern.repetition = repetition;
        pattern.isPattern = true;
        return pattern;
    }

    updateLineDashStyle() {
        // need apply the transformation matrix to the dashed value
        let def = this.lineDashedDef;

        if (def) {
            if (def.length > 0) {
                let xform = this.getCurrentTransform();
                let def1 = [];
                for (var i = 0; i < def.length; i++) {
                    let x = (def[i] * xform[0] + def[i] * xform[2]) * this.toPageUnits;
                    x = parseFloat(x.toFixed(6));
                    def1.push(x);
                }
                // 96 DPI was defined for lineStyleDef.js, and shader were expecting that value
                // when we parse the pdf, the effective dpi need to be ==> 96 / 72 / this.toPageUnits
                this.lineStyle = this.addNewDashedLineStyle({
                    def: def1
                }, 96 / 72 / this.toPageUnits);
            } else {
                this.lineStyle = 0;
            }
        }
        // In case of user directly controlled the line style
        // Do not set lineStyle to 0 here.
    }

    setCircleInfo(circleInfo) {
        this.circleInfo = circleInfo;
    }

    setCurrentOperatorIndex(index) {
        const addPointBBox = function(bbox, x, y) {
            bbox[0] = Math.min(bbox[0], x);
            bbox[1] = Math.min(bbox[1], y);
            bbox[2] = Math.max(bbox[2], x);
            bbox[3] = Math.max(bbox[3], y);
        };

        const transformBBox = function(bbox, xform) {
            let result = [1e10, 1e10, -1e10, -1e10]; // [minx, miny, maxx, maxy]
            // xform uses the canvas context convention: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/transform
            addPointBBox(result, bbox[0] * xform[0] + bbox[1] * xform[2] + xform[4], bbox[0] * xform[1] + bbox[1] * xform[3] + xform[5]); // minx, miny
            addPointBBox(result, bbox[0] * xform[0] + bbox[3] * xform[2] + xform[4], bbox[0] * xform[1] + bbox[3] * xform[3] + xform[5]); // minx, maxy
            addPointBBox(result, bbox[2] * xform[0] + bbox[1] * xform[2] + xform[4], bbox[2] * xform[1] + bbox[1] * xform[3] + xform[5]); // maxx, miny
            addPointBBox(result, bbox[2] * xform[0] + bbox[3] * xform[2] + xform[4], bbox[2] * xform[1] + bbox[3] * xform[3] + xform[5]); // maxx, maxy
            return result;
        };

        this.currentOpIndex = index;
        if (this.circleInfo && this.circleInfo[index]) {
            let xform = this.getCurrentTransform();
            let x = this.tx(this.circleInfo[index][0], this.circleInfo[index][1], xform);
            let y = this.ty(this.circleInfo[index][0], this.circleInfo[index][1], xform);

            // Inject the center of the circle
            const hiddenColor = 0x01ffffff; // Note that lineShader discards fully transparent fragments. Therefore, we use a white here with very small, but nonzero alpha.
            let c = this.currentVbb.addVertexLine(x, y, 0, 0.0001, 0, 0, hiddenColor, this.dbId, this.currentLayerId, this.currentVpId);
            this.currentVbb.finalizeQuad(c);
        }
        if (this.smallImageSequenceToCheck >= 0) {
            const sis = this.smallImageSequences[this.smallImageSequenceToCheck];
            if (sis.start == index) {
                // begin render into an actual canvas
                this.inSmallImageRendering = true;

                // compute actual area of interest in pixels (plus buffer)
                const imgBBox = transformBBox(sis.bbox, this.viewport.transform);
                const imgX = Math.floor(imgBBox[0]) - 1;
                const imgY = Math.floor(imgBBox[1]) - 1;
                const imgWidth = Math.ceil(imgBBox[2] - imgBBox[0]) + 2;
                const imgHeight = Math.ceil(imgBBox[3] - imgBBox[1]) + 2;

                // clear the area of interest and then fill with almost-transparent white
                // this will prevent dark borders that result from the default transparent black background
                this.canvasContext.save();
                this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);
                this.canvasContext._originalclearRect(imgX, imgY, imgWidth, imgHeight);
                this.canvasContext.fillStyle = 'rgba(255, 255, 255, 0.005)';
                this.canvasContext._originalfillRect(imgX, imgY, imgWidth, imgHeight);
                this.canvasContext.restore();
            } else if (sis.end == index) {
                // stop render into an actual canvas and send completed image to the VBB
                this.inSmallImageRendering = false;

                // compute actual area of interest in pixels (plus buffer)
                const imgBBox = transformBBox(sis.bbox, this.viewport.transform);
                const imgX = Math.floor(imgBBox[0]) - 1;
                const imgY = Math.floor(imgBBox[1]) - 1;
                const imgWidth = Math.ceil(imgBBox[2] - imgBBox[0]) + 2;
                const imgHeight = Math.ceil(imgBBox[3] - imgBBox[1]) + 2;

                // copy the relevant part into a new canvas (our texture handling only supports full images, no partial images)
                let imgCanvas = document.createElement("canvas");
                imgCanvas.width = imgWidth;
                imgCanvas.height = imgHeight;
                const imgCtx = imgCanvas.getContext("2d");
                imgCtx.drawImage(this.canvasContext.canvas, imgX, imgY, imgWidth, imgHeight, 0, 0, imgWidth, imgHeight);

                // send to our renderer
                this.canvasContext.save();
                this.canvasContext.setTransform(1, 0, 0, 1, 0, 0);
                this.canvasContext.drawImage(imgCanvas, imgX, imgY, imgWidth, imgHeight);
                this.canvasContext.restore();

                // advance to next sequence
                this.smallImageSequenceToCheck++;
                if (this.smallImageSequenceToCheck >= this.smallImageSequences.length) {
                    this.smallImageSequenceToCheck = -1;
                }
            }
        }
    }

    setSmallImageSequences(smallImageSequences) {
        if (smallImageSequences && smallImageSequences.length > 0) {
            this.smallImageSequences = smallImageSequences;
            this.smallImageSequenceToCheck = 0;
        }
    }

    // Set custom tesselation params for bezier arcs (see Bezier.h)
    // If undefined, we use the default settings.
    setTessParams(tessParams) {
        this.tessParams = tessParams;
    }

    finish() {
        this.flushBuffer(0, true);
        this.fontAtlas = null;
    }

    createViewPortData(matrix, units, precision) {
        return {
            "units": units || "feet and inches",
            "transform": matrix,
            "geom_metrics": this.initGeomMetrics(),
            "precision": precision
        };
    }

    isLMVCanvasContext() {
        return true;
    }

    //Initializes a structure of counters used for statistical purposes and sheet content hash
    initGeomMetrics() {
        return {
            "arcs": 0,
            "circles": 0,
            "circ_arcs": 0,
            "viewports": 0,
            "clips": 0,
            "colors": 0,
            "db_ids": 0,
            "dots": 0,
            "fills": 0,
            "layers": 0,
            "line_caps": 0,
            "line_joins": 0,
            "line_patterns": 0,
            "line_pat_refs": 0,
            "plines": 0,
            "pline_points": 0,
            "line_weights": 0,
            "links": 0,
            "miters": 0,
            "ptris": 0,
            "ptri_indices": 0,
            "ptri_points": 0,
            "rasters": 0,
            "texts": 0,
            "strings": []
        };
    }

    // Needs to be called when using
    //Copied from pdf.js, because our 2D renderer relies on mozCurrentTransform being available
    addContextCurrentTransform() {

        const ctx = this.canvasContext;

        if (!ctx.mozCurrentTransform) {
            ctx._originalSave = ctx.save;
            ctx._originalRestore = ctx.restore;
            ctx._originalRotate = ctx.rotate;
            ctx._originalScale = ctx.scale;
            ctx._originalTranslate = ctx.translate;
            ctx._originalTransform = ctx.transform;
            ctx._originalSetTransform = ctx.setTransform;
            ctx._transformMatrix = ctx._transformMatrix || [1, 0, 0, 1, 0, 0];
            ctx._transformStack = [];
            Object.defineProperty(ctx, 'mozCurrentTransform', {
                get: function getCurrentTransform() {
                    return this._transformMatrix;
                }
            });
            Object.defineProperty(ctx, 'mozCurrentTransformInverse', {
                get: function getCurrentTransformInverse() {
                    var m = this._transformMatrix;
                    var a = m[0],
                        b = m[1],
                        c = m[2],
                        d = m[3],
                        e = m[4],
                        f = m[5];
                    var ad_bc = a * d - b * c;
                    var bc_ad = b * c - a * d;
                    return [d / ad_bc, b / bc_ad, c / bc_ad, a / ad_bc, (d * e - c * f) / bc_ad, (b * e - a * f) / ad_bc];
                }
            });
            ctx.save = function ctxSave() {
                var old = this._transformMatrix;
                this._transformStack.push(old);
                this._transformMatrix = old.slice(0, 6);
                this._originalSave();
            };
            ctx.restore = function ctxRestore() {
                var prev = this._transformStack.pop();
                if (prev) {
                    this._transformMatrix = prev;
                    this._originalRestore();
                }
            };
            ctx.translate = function ctxTranslate(x, y) {
                var m = this._transformMatrix;
                m[4] = m[0] * x + m[2] * y + m[4];
                m[5] = m[1] * x + m[3] * y + m[5];
                this._originalTranslate(x, y);
            };
            ctx.scale = function ctxScale(x, y) {
                var m = this._transformMatrix;
                m[0] = m[0] * x;
                m[1] = m[1] * x;
                m[2] = m[2] * y;
                m[3] = m[3] * y;
                this._originalScale(x, y);
            };
            ctx.transform = function ctxTransform(a, b, c, d, e, f) {
                var m = this._transformMatrix;
                this._transformMatrix = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
                ctx._originalTransform(a, b, c, d, e, f);
            };
            ctx.setTransform = function ctxSetTransform(a, b, c, d, e, f) {
                this._transformMatrix = [a, b, c, d, e, f];
                ctx._originalSetTransform(a, b, c, d, e, f);
            };
            ctx.rotate = function ctxRotate(angle) {
                var cosValue = Math.cos(angle);
                var sinValue = Math.sin(angle);
                var m = this._transformMatrix;
                this._transformMatrix = [m[0] * cosValue + m[2] * sinValue, m[1] * cosValue + m[3] * sinValue, m[0] * -sinValue + m[2] * cosValue, m[1] * -sinValue + m[3] * cosValue, m[4], m[5]];
                this._originalRotate(angle);
            };
        }
    }

    // @returns {Boolean} - true: skip regular pdf.js logic, false: continue with regular pdf.js logic
    beginChildGroup(group) {
        // cannot handle groups with masks
        if (group.smask) {
            // set inChildGroup to false in case this is a nested group. It will get restore()'d to true when the nested group ends.
            this.inChildGroup = false;
            return false;
        }
        // TODO: LMV-5595 (isolated groups)

        this.flushBuffer(0, true);

        // how should we handle nested groups? We would have to apply a sequence of compositions and transparencies in a single rendering call.
        // solution for now: only apply the topmost composition operation, but combine alpha
        this.overrideCompositeOperation = this.canvasContext.globalCompositeOperation;
        this.overrideAlpha *= this.canvasContext.globalAlpha;

        this.inChildGroup = true;

        return true;
    }

    // @returns {Boolean} - true: skip regular pdf.js logic, false: continue with regular pdf.js logic
    // Matching beginChildGroup()/endChildGroup() pairs must return the same value to not confuse pdf.js!
    endChildGroup(group) {
        if (!this.inChildGroup) {
            return false;
        }

        this.flushBuffer(0, true);

        return true;
    }

    _getModelToViewportMatrix(vpData, isUnitsDefined) {
        // This is the model to vp matrix without 300 / 72 viewport scaling
        let vp = typeof vpData === 'string' ? JSON.parse(vpData) : vpData;

        // Apply the viewport scale
        if (isUnitsDefined) {
            const vpMat = new Autodesk.Viewing.Private.LmvMatrix4(true).fromArray(vp);
            const scale = new Autodesk.Viewing.Private.LmvMatrix4(true).makeScale(this.viewport.scale, this.viewport.scale, 1);

            scale.multiply(vpMat);
            vp = scale.elements;
        }
        return vp;
    }

}

/**
 * Class used to normalize gradient data.
 */
class GradientData {
    constructor(color) {
        // RawData comes from PDFjs.
        if (Object.prototype.hasOwnProperty.call(color, 'rawData')) {
            const data = color.rawData;
            this.type = data[1];
            this.colorStops = data[3];
            this.startPoint = data[4];
            this.endPoint = data[5];
            this.startRadius = data[6];
            this.endRadius = data[7];
        } else {
            Object.assign(this, color);
        }
    }

    /**
     * Check if the GradientData is valid.
     * @return {boolean} - true if valid.
     */
    isValid() {
        if (!this.type || !this.startPoint || !this.endPoint || !this.colorStops) {
            return false;
        }

        if (this.type === 'radial' && (this.startRadius === undefined || this.endRadius === undefined)) {
            return false;
        }

        return true;
    }

    /**
     * Creates a temporary canvasGradient with all of the GradientData properties assigned to it.
     * This is required when assigning a context's fillstyle.
     * @param {CanvasRenderingContext2D} ctx - 2d render context.
     * @returns {CanvasGradient} - containing the GradientData's properties
     */
    getFillStyle(ctx) {
        if (!this.isValid()) {
            return;
        }
        // This is a temporary gradient. It is only used to pass the gradient data's properties to the fillStyle.
        const tempGradient = ctx.createLinearGradient(0, 0, 1, 1);
        Object.assign(tempGradient, this);
        return tempGradient;
    }

    /**
     * Generate a CanvasGradient.
     * @param {CanvasRenderingContext2D} ctx - 2d render context.
     * @param {number[]} [startPoint] - modified start position
     * @param {number[]} [endPoint] - modified end position
     * @returns {CanvasGradient} - Canvas Gradient
     */
    generateCanvasGradient(ctx, startPoint, endPoint) {
        if (!this.isValid()) {
            return;
        }
        const type = this.type;
        const colorStops = this.colorStops;
        const p0 = startPoint || this.startPoint;
        const p1 = endPoint || this.endPoint;
        const r0 = this.startRadius;
        const r1 = this.endRadius;
        let grad = null;

        if (type === 'axial' || type === 'linear') {
            grad = ctx.createLinearGradient(p0[0], p0[1], p1[0], p1[1]);
        } else if (type === 'radial') {
            grad = ctx.createRadialGradient(p0[0], p0[1], r0, p1[0], p1[1], r1);
        }
        for (let i = 0, ii = colorStops.length; i < ii; ++i) {
            const c = colorStops[i];
            grad.addColorStop(c[0], c[1]);
        }

        return grad;
    }
}