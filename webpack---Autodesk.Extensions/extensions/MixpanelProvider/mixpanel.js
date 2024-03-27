import mixpanel from 'mixpanel-browser';
const logger = Autodesk.Viewing.Private.logger;

const PROVIDER_NAME = 'mixpanel';

/** 
 * Wraps the mixpanel api for sending usage data
 *
 */
class Mixpanel extends Autodesk.Viewing.Private.AnalyticsProviderInterface {
    constructor(options) {
        super(options);
        this.initialized = false;
    }

    init() {
        if (!this.options.token) {
            logger.warn('Mixpanel token is not defined');
        }
        mixpanel.init(this.options.token, this.options.config);
        this.initialized = true;
    }

    // Register super properties - https://developer.mixpanel.com/docs/javascript#super-properties
    // These are sent with every track request
    register(props) {
        mixpanel.register(props);
    }

    static get name() {
        return PROVIDER_NAME;
    }

    static get defaultOptions() {
        return {
            token: '7cecb637d6468a8b61f388bbb82072ee', // Viewer Mixpanel account
            config: {
                persistence: 'localStorage',
                batch_requests: true,
                batch_size: 500,
                batch_flush_interval_ms: 15000,
                // The autotrack option is needed to prevent a GET request below on mixpanel.init() 
                // GET https://api-js.mixpanel.com/decide/?verbose=1&version=1&lib=web&token=xxx
                //
                // Mixpanel-support discourages using the undocumented autotrack option, instead recommends having users opted out by default 
                // until the user agrees and then opt them in. On any next page load, we can opt-in by default as we already have an agreement.
                // However, LMV doesn't have a consent form, and needs users opted-in by default
                autotrack: false
            }
        };
    }

    hasOptedOut() {
        return mixpanel.has_opted_out_tracking();
    }

    optOut(options) {
        // Opt a user out of data collection
        this.track('OptOutTracking');
        mixpanel.opt_out_tracking(options);
    }

    getDistinctId() {
        return mixpanel.get_distinct_id();
    }

    optIn(options) {
        // Opt the user in to data tracking
        mixpanel.opt_in_tracking(options);
        this.track('OptInTracking');
    }

    track(event, properties) {
        mixpanel.track(event, properties);
    }

    /**
     * Can be called by a product to identify the user
     * @param {string} distinctId
     */
    identify(distinctId) {
        mixpanel.identify(distinctId);
    }
}


export {
    Mixpanel
};