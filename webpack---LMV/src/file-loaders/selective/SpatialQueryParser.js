import {
    Box3,
    Vector3
} from 'three';


const aabbox = new Box3(); // auxiliary proxy

export class SpatialQueryParser {

    static _buildNotCondition(condition) {
        const predicate = this._parse(condition);
        return (model, fragmentID) => {
            return !predicate(model, fragmentID);
        };
    }

    static _buildOrCondition(conditions) {
        const predicates = new Array();
        if (conditions instanceof Array) {
            for (let i = 0; i < conditions.length; ++i) {
                predicates.push(this._parse(conditions[i]));
            }
        }
        return (model, fragmentID) => {
            for (const predicate of predicates) {
                if (predicate(model, fragmentID)) {
                    return true;
                }
            }
            return false;
        };
    }

    static _buildAndCondition(conditions) {
        const predicates = new Array();
        if (conditions instanceof Array) {
            for (let i = 0; i < conditions.length; ++i) {
                predicates.push(this._parse(conditions[i]));
            }
        }
        return (model, fragmentID) => {
            let result = true;
            for (const predicate of predicates) {
                result &= predicate(model, fragmentID);
            }
            return result;
        };
    }

    static _buildEnclosesClause(operands) {

        const primitive = operands[0];
        let primitiveType;
        for (primitiveType in primitive) break;

        const aabox = new Box3(); // primitive, asuming only aabox currently works
        [aabox.min.x, aabox.min.y, aabox.min.z, aabox.max.x, aabox.max.y, aabox.max.z] = primitive[primitiveType];

        const epsilon = operands.length > 1 && typeof operands[2] === 'number' ? operands[2] : 1e-8;
        epsilon !== 0.0 && aabox.expandByScalar(epsilon);

        return (model, fragmentID) => {
            model.getFragmentList().getWorldBounds(fragmentID, aabbox);
            return aabox.containsBox(aabbox);
        };
    }

    static _buildIntersectsClause(operands) {

        // const proxy = SpatialQueryParser.$proxy(condition[0]); // ??
        const primitive = operands[0];
        let primitiveType;
        for (primitiveType in primitive) break;

        const aabox = new Box3(); // primitive
        [aabox.min.x, aabox.min.y, aabox.min.z, aabox.max.x, aabox.max.y, aabox.max.z] = primitive[primitiveType];

        return (model, fragmentID) => {
            model.getFragmentList().getWorldBounds(fragmentID, aabbox);
            return aabox.intersectsBox(aabbox);
        };
    }

    static _buildExtentClause(threshold) {

        return (model, fragmentID) => {

            const aabbox = new Box3();
            model.getFragmentList().getWorldBounds(fragmentID, aabbox);
            const sizeVec = new Vector3();
            aabbox.getSize(sizeVec);
            const size = sizeVec.x * sizeVec.y * sizeVec.z;

            return size > threshold;
        };
    }


    static _parse(object) {

        let type;
        for (type in object) break; // get first property key
        switch (type) {
            case '$not':
                return this._buildNotCondition(object[type]);
            case '$or':
                return this._buildOrCondition(object[type]);
            case '$and':
                return this._buildAndCondition(object[type]);
            case '$encloses':
                return this._buildEnclosesClause(object[type]);
            case '$intersects':
                return this._buildIntersectsClause(object[type]);
            case '$extent':
                return this._buildExtentClause(object[type]);
            default:
                console.warn('Spatial Query Parser: condition type not supported, given', type);
                return undefined;
        }
    }

    static parse(queryObject) {
        return this._parse(queryObject);
    }

}