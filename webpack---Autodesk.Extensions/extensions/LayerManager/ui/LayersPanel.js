import "./LayersPanel.css";
const debounce = require("lodash/debounce");

const av = Autodesk.Viewing;
const avu = Autodesk.Viewing.UI;
const avp = Autodesk.Viewing.Private;

const i18n = av.i18n;
const DockingPanel = avu.DockingPanel;
const TreeDelegate = avu.TreeDelegate;
const Filterbox = avu.Filterbox;
const Tree = avu.Tree;
/**
 * The Layer Panel allows users to explore and set the visibility state of the different layers in the loaded model.
 * A layer is identified by a string label and represents a collection of geometry grouped by some criteria.
 * 
 * @alias Autodesk.Viewing.UI.LayersPanel
 * @augments Autodesk.Viewing.UI.DockingPanel
 * @param {Viewer} viewer - The parent viewer.
 * @param {HTMLElement} parentContainer - The container for this panel.
 * @param {string} id - The id for this panel.
 * @param {object} [options] - An optional dictionary of options.
 * @constructor
 */
export function LayersPanel(viewer, parentContainer, id, options) {

    this.viewer = viewer;
    this.setGlobalManager(viewer.globalManager);
    this.tree = null;
    this.layersRoot = null;
    this.visibilityImages = {};
    this.isMac = (navigator.userAgent.search("Mac OS") !== -1);

    var title = "Layers"; // Gets translated by DockingPanel's constructor

    DockingPanel.call(this, viewer.container, id, title, options);
    this.container.classList.add('layers-panel');
    this.container.style.top = "10px";
    this.container.style.left = "10px";

    var that = this;
    if (viewer.model) {
        that.build();
    } else {
        that.addEventListener(viewer, av.GEOMETRY_LOADED_EVENT, function() {
            that.build();
        });
    }

    var shown = false;
    this.addVisibilityListener(function() {
        if (!shown) {
            shown = true;
            that.resizeToContent();
        }
    });
}

LayersPanel.prototype = Object.create(DockingPanel.prototype);
LayersPanel.prototype.constructor = LayersPanel;

/**
 * Clean up when the layers panel is about to be removed.
 * @override
 */
LayersPanel.prototype.uninitialize = function() {
    DockingPanel.prototype.uninitialize.call(this);

    this.viewer = null;
    this.tree = null;
    this.layersRoot = null;
    this.scrollContainer = null;
};

/**
 * Builds the layers panel.
 */
LayersPanel.prototype.build = function() {
    var that = this;
    const sendAnalyticsDebounced = debounce((from, action) => {
        avp.analytics.track('viewer.layers', {
            from: from,
            action: action,
        });
    }, 2000);

    function createDelegate() {
        var delegate = new TreeDelegate();
        delegate.setGlobalManager(that.globalManager);

        delegate.getTreeNodeId = function(node) {
            return node.id;
        };

        delegate.getTreeNodeLabel = function(node) {
            return that.getNodeLabel(node);
        };

        delegate.getTreeNodeClass = function(node) {
            return that.getNodeClass(node);
        };

        delegate.isTreeNodeGroup = function(node) {
            return that.isGroupNode(node);
        };

        delegate.shouldCreateTreeNode = function(node) {
            return that.shouldInclude(node);
        };

        delegate.onTreeNodeClick = function(tree, node, event) {
            that.onClick(node, event);
            avp.analytics.track('viewer.layers', {
                from: 'Panel.TreeNode',
                action: 'Toggle Visibility',
            });
        };

        delegate.onTreeNodeRightClick = function(tree, node, event) {
            that.onRightClick(node, event);
        };

        delegate.onTreeNodeDoubleClick = function(tree, node, event) {
            that.onDoubleClick(node, event);
        };

        delegate.onTreeNodeIconClick = function(tree, node, event) {
            that.onIconClick(node, event);
        };

        delegate.createTreeNode = function(node, parent) {
            that.createNode(node, parent);
        };

        return delegate;
    }

    // All visibility button.
    const _document = this.getDocument();
    var button = _document.createElement('div');

    button.classList.add('visibility');
    button.title = i18n.translate('Show/hide all layers');

    button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        this.viewer.setLayerVisible(null, this.viewer.allLayersHidden());
        avp.analytics.track('viewer.layers', {
            from: 'Panel',
            action: this.viewer.allLayersHidden() ? 'Show All' : 'Hide All',
        });
    }.bind(this));

    this.container.appendChild(button);
    this.toogleAllVisibleButton = button;

    // Add filterbox.
    var searchTimer = null;
    var searchText = "";
    var viewer = that.viewer;

    function doFiltering() {

        function getMatches(node) {
            var matches = [];
            if (node.name.toLowerCase().indexOf(searchText) !== -1) {
                matches.push(node);
            } else if (!node.isLayer) {
                var children = node.children;
                for (var i = 0; i < children.length; ++i) {
                    matches = matches.concat(getMatches(children[i]));
                }
            }
            return matches;
        }

        if (searchText) {
            if (layersRoot && 0 < layersRoot.childCount) {
                that.lockoutClearFilter = true;
                viewer.setLayerVisible(getMatches(layersRoot), true, true);
                that.lockoutClearFilter = false;
            }
        } else {
            // Make all the layers visible.
            viewer.setLayerVisible(null, true);
        }

        sendAnalyticsDebounced('Panel', 'Search');

        searchTimer = null;
    }

    function doIncrementalFiltering(text) {

        if (searchTimer) {
            clearTimeout(searchTimer);
        }
        searchText = text ? text.toLowerCase() : text;
        searchTimer = setTimeout(doFiltering, 500);
    }

    this.filterbox = new Filterbox(this.viewer.container.id + 'LayersPanel' + '-Filterbox', {
        filterFunction: doIncrementalFiltering
    });
    this.filterbox.setGlobalManager(this.globalManager);
    this.container.appendChild(this.filterbox.container);

    // Layer tree.
    this.createScrollContainer({
        heightAdjustment: 104,
        marginTop: 0
    });

    var scrollContainerBackground = _document.createElement('div');
    scrollContainerBackground.classList.add('docking-panel-container-gradient');
    scrollContainerBackground.style.width = '100%';
    scrollContainerBackground.style.height = '100%';
    this.scrollContainer.appendChild(scrollContainerBackground);
    /*
        filterBox.addEventListener('keyup', function (e) {
            doIncrementalSearch();
        });

        // This is to detect when the user clicks on the 'x' to clear.
        filterBox.addEventListener('click', function (e) {
            if (filterBox.value === '') {
                viewer.setLayerVisible(null, true);
                return;
            }

            // When this event is fired after clicking on the clear button
            // the value is not cleared yet. We have to wait for it.
            setTimeout(function () {
                if (filterBox.value === '') {
                    viewer.setLayerVisible(null, true);
                    e.preventDefault();
                }
            }, 1);
        });
    */
    var delegate = createDelegate(),
        layersRoot = that.layersRoot = that.viewer.impl.getLayersRoot();

    if (layersRoot) {
        that.tree = new Tree(delegate, layersRoot, scrollContainerBackground, {
            excludeRoot: true
        });
        that.tree.setGlobalManager(that.globalManager);

        that.update();

        that.addEventListener(that.viewer, av.LAYER_VISIBILITY_CHANGED_EVENT, function() {
            that.update();
        });
    }
};

/**
 * Updates the visibility states for the layers in the panel.
 */
LayersPanel.prototype.update = function() {
    var that = this;

    function updateLook(node, state) {
        if (state === 0) {
            that.tree.addClass(node.id, 'dim');
        } else { // state === 1 || state === -1
            that.tree.removeClass(node.id, "dim");
        }
    }

    function traverse(layerNode) {
        if (layerNode.isLayer) {
            var visible = that.viewer.isLayerVisible(layerNode) ? 1 : 0;
            updateLook(layerNode, visible);
            return visible;
        } else {
            var children = layerNode.children;
            var dadVisible = 0;
            for (var i = 0; i < children.length; ++i) {
                var childVisible = traverse(children[i]);
                dadVisible = dadVisible || childVisible;
            }
            updateLook(layerNode, dadVisible);
        }
    }

    // Updatea visibility buttons.
    if (this.layersRoot && 0 < this.layersRoot.childCount) {
        traverse(that.layersRoot);
    }

    if (this.viewer.allLayersHidden()) {
        this.toogleAllVisibleButton.classList.add('dim');
    } else {
        this.toogleAllVisibleButton.classList.remove('dim');
    }
};

/**
 * Toggle or isolate the visibility state for a layer node.
 * @param {?Object} node
 * @param {boolean=} [isolate=false] true to isolate, false to toggle
 */
LayersPanel.prototype.setLayerVisible = function(node, isolate) {
    var visible = isolate;

    if (node !== null && !isolate) {
        visible = !this.viewer.impl.layers.isLayerVisible(node);
    }

    this.viewer.setLayerVisible(node, visible, isolate);
    //   this.filterBox.value = '';

    // Clear selection for better UX
    // Apply at the end so that it can be worked around if needed.
    this.viewer.clearSelection();
};

/**
 * Override this method to specify the label for a node.
 * @param {Object} node
 * @returns {string} Label of the tree node
 */
LayersPanel.prototype.getNodeLabel = function(node) {
    return (node.isLayer || 0 === node.childCount) ? node.name : (node.name + " (" + node.childCount + ")");
};

/**
 * Override this to specify the CSS classes of a node. This way, in CSS, the designer
 * can specify custom styling per type.
 * By default, an empty string is returned.
 * @param {Object} node
 * @returns {string} CSS classes for the node
 */
LayersPanel.prototype.getNodeClass = function(node) {
    return '';
};

/**
 * Override this method to specify whether or not a node is a group node.
 * @param {Object} node
 * @returns {boolean} true if this node is a group node, false otherwise
 */
LayersPanel.prototype.isGroupNode = function(node) {
    return !node.isLayer;
};

/**
 * Override this method to specify if a tree node should be created for this node.
 * By default, every node will be displayed.
 * @param {Object} node
 * @returns {boolean} true if a node should be created, false otherwise
 */
LayersPanel.prototype.shouldInclude = function(node) {
    return true;
};

/**
 * Override this to do something when the user clicks on a tree node's icon.
 * By default, groups will be expanded/collapsed.
 * @param {Object} node
 * @param {Event} event
 */
LayersPanel.prototype.onIconClick = function(node, event) {
    this.setGroupCollapsed(node, !this.isGroupCollapsed(node));
};

/**
 * Collapse/expand a group node.
 * @param {Object} node - A node to collapse/expand in the tree.
 * @param {boolean} collapse - true to collapse the group, false to expand it.
 */
LayersPanel.prototype.setGroupCollapsed = function(node, collapse) {
    var delegate = this.tree.delegate();
    if (delegate.isTreeNodeGroup(node)) {
        var id = delegate.getTreeNodeId(node);
        this.tree.setCollapsed(id, collapse);
    }
};

/**
 * Returns true if the group is collapsed.
 * @param {Object} node - The node in the tree.
 * @returns {boolean} - true if the group is collapsed, false otherwise.
 */
LayersPanel.prototype.isGroupCollapsed = function(node) {
    var delegate = this.tree.delegate();
    if (delegate.isTreeNodeGroup(node)) {
        var id = delegate.getTreeNodeId(node);
        return this.tree.isCollapsed(id);
    }
    return false;
};
/**
 * Override this method to do something when the user clicks on a tree node
 * @param {Object} node
 * @param {Event} event
 */
LayersPanel.prototype.onClick = function(node, event) {};

/**
 * Override this to do something when the user double-clicks on a tree node
 * @param {Object} node
 * @param {Event} event
 */
LayersPanel.prototype.onDoubleClick = function(node, event) {};

/**
 * Override this to do something when the user right-clicks on a tree node
 * @param {Object} node
 * @param {Event} event
 */
LayersPanel.prototype.onRightClick = function(node, event) {};

/**
 * Override this to do something when the user clicks on an image
 * @param {Object} node
 * @param {Event} event
 */
LayersPanel.prototype.onImageClick = function(node, event) {};

/**
 * Returns the width and height to be used when resizing the panel to the content.
 *
 * @returns {{height: number, width: number}}
 */
LayersPanel.prototype.getContentSize = function() {

    var size = {
        width: 0,
        height: this.options.heightAdjustment || 0
    };

    // Add filter size.
    var filter = this.filterbox.container;

    size.width += filter.clientWidth;
    size.height += filter.clientHeight;

    // Add treeview size.
    var layers = this.container.querySelectorAll('leaf');
    if (layers.length > 0) {
        size.height += layers[0].clientHeight * layers.length;
    }

    return size;
};

/**
 * Override this to create the HTMLContent for this node for appending to the
 * parent.  By default, a label and a visibility image are created.
 * @param {Object} node
 * @param {HTMLElement} parent
 */
LayersPanel.prototype.createNode = function(node, parent) {

    // Add visibility button.
    const _document = this.getDocument();
    var button = _document.createElement('div');

    button.dbId = node;
    button.classList.add('visibility');
    button.title = i18n.translate("Show/hide this layer");

    button.addEventListener('mousedown', function(event) {
        event.preventDefault();
        event.stopPropagation();
    }.bind(this));

    button.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        this.onImageClick(node, event);
        avp.analytics.track('viewer.layers', {
            from: 'Panel.TreeIcon',
            action: 'Toggle Visibility',
        });
    }.bind(this));

    parent.appendChild(button);

    // Add label.
    var label = _document.createElement('label');
    label.textContent = this.getNodeLabel(node);
    parent.appendChild(label);
};