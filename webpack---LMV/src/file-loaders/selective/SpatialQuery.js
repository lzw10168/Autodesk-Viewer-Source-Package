import {
    SpatialQueryParser
} from './SpatialQueryParser';


export class SpatialQuery {

    _source;
    _predicate;


    static validate(queryString) {
        /** @todo: implement */
        return true;
    }

    fromString(queryString) {
        if (this._source === queryString) {
            return;
        }
        this._predicate = undefined;
        if (queryString === undefined || queryString.length === 0) {
            this._source = undefined;
            return;
        }
        if (!SpatialQuery.validate(queryString)) {
            console.warn('Validation of spatial query failed, given:', queryString);
            this._source = undefined;
            return;
        }
        this._source = queryString;
    }

    fromObject(queryObject) {
        if (queryObject === undefined || Object.keys(queryObject).length === 0) {
            this._source = undefined;
            this._predicate = undefined;
            return;
        }
        const queryString = JSON.stringify(queryObject);
        this.fromString(queryString);
    }

    isEmpty() {
        return this._source === undefined;
    }

    isReady() {
        return !!this._predicate;
    }

    initialize() {
        // Either not source is set (then predicate should be undefined) or predicate was initialized.
        if (this.isEmpty() || this.isReady()) {
            return;
        }
        const object = JSON.parse(this._source, (key, value) =>
            typeof value === 'number' ? parseFloat(value) : value);
        this._predicate = SpatialQueryParser.parse(object);
    }

    get isFragmentPassing() {
        return this._predicate;
    }

}