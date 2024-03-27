const av = Autodesk.Viewing;
const namespace = AutodeskNamespace('Autodesk.Edit3D');
const myExtensionName = 'Autodesk.Edit3D';

import Gizmo3D from './Gizmo3D.js';
import Label3D from './Label3D.js';
import PointMarker from './PointMarker.js';
import CoordPicker from './CoordPicker.js';
import TwoPointPicker from './TwoPointPicker.js';
import NPointPicker from "./NPointPicker.js";

/** 
 * Edit3D extension is a collection of general-purpose helper classes to faciliate 
 * implementation of 3D EditTools.
 * Loading the extension does not add UI or changes behavior in the viewer. Its purpose is only
 * to provide a basis for other extensions and client applications.
 * 
 * The extension id is: `Autodesk.Edit3D`
 * 
 * @example
 *   viewer.loadExtension('Autodesk.Edit3D')
 *
 * @memberof Autodesk.Viewing.Extensions
 * @see {@link Autodesk.Viewing.Extension} for common inherited methods.
 * @alias Autodesk.Viewing.Extensions.Edit3DExtension
 * @class
 */
export default class Edit3DExtension extends av.Extension {
    constructor(viewer, options) {
        super(viewer, options);
    }
}

namespace.Gizmo3D = Gizmo3D;
namespace.Label3D = Label3D;
namespace.PointMarker = PointMarker;
namespace.CoordPicker = CoordPicker;
namespace.TwoPointPicker = TwoPointPicker;
namespace.NPointPicker = NPointPicker;

// Register the extension with the extension manager.
av.theExtensionManager.registerExtension(myExtensionName, Edit3DExtension);