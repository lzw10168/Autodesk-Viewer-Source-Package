import {
    Mixpanel
} from './mixpanel';

const av = Autodesk.Viewing;
const avp = av.Private;

class MixpanelExtension extends Autodesk.Viewing.Extension {

    constructor(viewer, options) {
        super(viewer, options);
    }

    load() {
        return true;
    }
    unload() {
        return true;
    }
    activate() {
        return true;
    }
    deactivate() {
        return false;
    }
}

av.theExtensionManager.registerExtension('Autodesk.Viewing.MixpanelExtension', MixpanelExtension);
avp.analytics.registerProvider(Mixpanel);