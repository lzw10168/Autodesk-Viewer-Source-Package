"use strict";

/**
 * The FileLoaderManager manages a set of file loaders available to the viewer.
 * Register, retrieve, and unregister your file loaders using the singleton theFileLoader.
 * @private
 */
const fileLoaders = {};

/**
 * Registers a new file loader with the given id.
 *
 * @param {String} fileLoaderId - The string id of the file loader.
 * @param {String[]} fileExtensions - The array of supported file extensions. Ex: ['stl', 'obj']
 * @param {Function} fileLoaderClass - The file loader constructor.
 * @param {String} mimeType - The content type the file loader can handle
 * @returns {Boolean} - True if the file loader was successfully registered.
 * 
 * @private
 */
function registerFileLoader(fileLoaderId, fileExtensions, fileLoaderClass, mimeType) {

    if (!fileLoaders[fileLoaderId]) {
        fileLoaders[fileLoaderId] = {
            loader: fileLoaderClass,
            extensions: fileExtensions,
            mimeType: mimeType,
            count: 1
        };
        return true;
    }

    if (fileLoaders[fileLoaderId].loader === fileLoaderClass) {
        fileLoaders[fileLoaderId].count++;
        return true;
    }

    return false;
}

/**
 * Returns the file loader for a given ID.
 *
 * @param {String} fileLoaderId - The string id of the file loader.
 * @returns {Function?} - The file loader constructor if one was registered; null otherwise.
 * 
 * @private
 */
function getFileLoader(fileLoaderId) {
    if (fileLoaders[fileLoaderId]) {
        return fileLoaders[fileLoaderId].loader;
    }
    return null;
}

/**
 * Unregisters an existing file loader with the given id.
 *
 * @param {String} fileLoaderId - The string id of the file loader.
 * @returns {Boolean} - True if the file loader was successfully unregistered.
 * 
 * @private
 */
function unregisterFileLoader(fileLoaderId) {
    if (fileLoaders[fileLoaderId]) {
        fileLoaders[fileLoaderId].count--;
        if (fileLoaders[fileLoaderId].count === 0) {
            delete fileLoaders[fileLoaderId];
        }
        return true;
    }
    return false;
}

/**
 * Returns a file loader that supports the given extension.
 *
 * @param {String} fileExtension - The file extension.
 * @param {String=} mimeType - The type of file content if available.
 *
 * @returns {Function?} - The file loader constructor if one is found; null otherwise.
 * 
 * @private
 */
function getFileLoaderForExtension(fileExtension, mimeType) {
    fileExtension = fileExtension ? fileExtension.toLowerCase() : "";

    const result = new Array();

    for (const fileLoaderId in fileLoaders) {
        const fileLoader = fileLoaders[fileLoaderId];
        if (!fileLoader) {
            continue;
        }

        for (let i = 0; i < fileLoader.extensions.length; i++) {
            if (fileLoader.extensions[i].toLowerCase() === fileExtension) {
                result.push(fileLoader.loader);
            }
        }
    }

    if (result.length === 0) {
        return null;
    }

    // If a mimetype is provided, try to solve ambiguity this way
    if (mimeType && result.length > 1) {
        for (let loader of result) {
            if (loader.acceptsMimeType && loader.acceptsMimeType(mimeType)) {
                return loader;
            }
        }
    }

    // try with the first one found
    return result[0];
}

export let FileLoaderManager = {
    registerFileLoader: registerFileLoader,
    getFileLoader: getFileLoader,
    getFileLoaderForExtension: getFileLoaderForExtension,
    unregisterFileLoader: unregisterFileLoader
};