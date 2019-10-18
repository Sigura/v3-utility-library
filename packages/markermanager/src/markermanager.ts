/// <reference types="@types/googlemaps" />

/**
 * Creates a new MarkerManager that will show/hide markers on a map.
 *
 * Events:
 * @event changed (Parameters: shown bounds, shown markers) Notify listeners when the state of what is displayed changes.
 * @event loaded MarkerManager has succesfully been initialized.
 *
 * @constructor
 * @param {Map} map The map to manage.
 * @param {Object} opt_opts A container for optional arguments:
 *   {Number} maxZoom The maximum zoom level for which to create tiles.
 *   {Number} borderPadding The width in pixels beyond the map border,
 *                   where markers should be display.
 *   {Boolean} trackMarkers Whether or not this manager should track marker
 *                   movements.
 */
class MarkerManager {
  public shown: boolean;
  public shownMarkers: number;

  /**
   *  Default tile size used for deviding the map into a grid.
   */
  private DEFAULT_TILE_SIZE = 1024;

  /*
   *  How much extra space to show around the map border so
   *  dragging doesn't result in an empty place.
   */
  private DEFAULT_BORDER_PADDING = 100;

  /**
   *  Default tilesize of single tile world.
   */
  private _MERCATOR_ZOOM_LEVEL_ZERO_RANGE = 256;
  private _map: google.maps.Map;
  private _mapZoom: number;
  private _maxZoom: number;
  private _tileSize: number;
  private trackMarkers: boolean;
  private swPadding: google.maps.Size;
  private nePadding: google.maps.Size;
  private gridWidth: { [k: string]: number };
  private grid: google.maps.Marker[][][][];
  private numMarkers: { [k: string]: number };
  private shownBounds: GridBounds;

  constructor(map: google.maps.Map, opt_opts: { [k: string]: any }) {
    this._map = map;
    this._mapZoom = map.getZoom();

    google.maps.event.addListenerOnce(map, "idle", () => {
      this.initialize(map, opt_opts);
    });
  }

  initialize(map: google.maps.Map, opt_opts: { [k: string]: any }) {
    opt_opts = opt_opts || {};
    this._tileSize = this.DEFAULT_TILE_SIZE;

    var mapTypes = map.mapTypes;

    // Find max zoom level
    var mapMaxZoom = 1;
    for (var sType in mapTypes) {
      if (
        mapTypes.hasOwnProperty(sType) &&
        mapTypes.get(sType) &&
        mapTypes.get(sType).maxZoom === "number"
      ) {
        var mapTypeMaxZoom = map.mapTypes.get(sType).maxZoom;
        if (mapTypeMaxZoom > mapMaxZoom) {
          mapMaxZoom = mapTypeMaxZoom;
        }
      }
    }

    this._maxZoom = opt_opts.maxZoom || 19;

    this.trackMarkers = opt_opts.trackMarkers;
    this.shown = opt_opts.show || true;

    var padding;
    if (typeof opt_opts.borderPadding === "number") {
      padding = opt_opts.borderPadding;
    } else {
      padding = this.DEFAULT_BORDER_PADDING;
    }
    // The padding in pixels beyond the viewport, where we will pre-load markers.
    this.swPadding = new google.maps.Size(-padding, padding);
    this.nePadding = new google.maps.Size(padding, -padding);

    this.gridWidth = {};

    this.grid = [];
    this.grid[this._maxZoom] = [];
    this.numMarkers = {};
    this.numMarkers[this._maxZoom] = 0;

    google.maps.event.addListener(map, "dragend", this.onMapMoveEnd.bind(this));

    google.maps.event.addListener(map, "idle", this.onMapMoveEnd.bind(this));

    google.maps.event.addListener(
      map,
      "zoom_changed",
      this.onMapMoveEnd.bind(this)
    );

    this.resetManager();
    this.shownMarkers = 0;

    this.shownBounds = this.getMapGridBounds();

    google.maps.event.trigger(this, "loaded");
  }
  /**
   * This closure provide easy access to the map.
   * They are used as callbacks, not as methods.
   * @param marker Marker to be removed from the map
   */
  private removeOverlay(marker: google.maps.Marker) {
    marker.setMap(null);
    this.shownMarkers--;
  }

  /**
   * This closure provide easy access to the map.
   * They are used as callbacks, not as methods.
   * @param marker Marker to be added to the map
   */
  private addOverlay(marker: google.maps.Marker): void {
    if (this.shown) {
      marker.setMap(this._map);
      this.shownMarkers++;
    }
  }

  /**
   * Initializes MarkerManager arrays for all zoom levels
   * Called by constructor and by clearAllMarkers
   */
  public resetManager(): void {
    var mapWidth = this._MERCATOR_ZOOM_LEVEL_ZERO_RANGE;
    for (var zoom = 0; zoom <= this._maxZoom; ++zoom) {
      this.grid[zoom] = [];
      this.numMarkers[zoom] = 0;
      this.gridWidth[zoom] = Math.ceil(mapWidth / this._tileSize);
      mapWidth <<= 1;
    }
  }

  /**
   * Removes all markers in the manager, and
   * removes any visible markers from the map.
   */
  public clearMarkers(): void {
    this.processAll(this.shownBounds, this.removeOverlay.bind(this));
    this.resetManager();
  }

  /**
   * Gets the tile coordinate for a given latlng point.
   *
   * @param {LatLng} latlng The geographical point.
   * @param {Number} zoom The zoom level.
   * @param {google.maps.Size} padding The padding used to shift the pixel coordinate.
   *               Used for expanding a bounds to include an extra padding
   *               of pixels surrounding the bounds.
   * @return {GPoint} The point in tile coordinates.
   *
   */
  private getTilePoint(
    latlng: google.maps.LatLng,
    zoom: number,
    padding: google.maps.Size
  ): google.maps.Point {
    var pixelPoint = latLngToPixel(latlng, zoom);

    var point = new google.maps.Point(
      Math.floor((pixelPoint.x + padding.width) / this._tileSize),
      Math.floor((pixelPoint.y + padding.height) / this._tileSize)
    );

    return point;
  }

  /**
   * Finds the appropriate place to add the marker to the grid.
   * Optimized for speed; does not actually add the marker to the map.
   * Designed for batch-processing thousands of markers.
   *
   * @param {Marker} marker The marker to add.
   * @param {Number} minZoom The minimum zoom for displaying the marker.
   * @param {Number} maxZoom The maximum zoom for displaying the marker.
   */
  public addMarkerBatch(
    marker: google.maps.Marker,
    minZoom: number,
    maxZoom: number
  ) {
    var me = this;

    var mPoint = marker.getPosition();
    marker.set("MarkerManager_minZoom", minZoom);

    // Tracking markers is expensive, so we do this only if the
    // user explicitly requested it when creating marker manager.
    if (this.trackMarkers) {
      google.maps.event.addListener(marker, "changed", function(a, b, c) {
        this.onMarkerMoved(a, b, c);
      });
    }

    var gridPoint = this.getTilePoint(
      mPoint,
      maxZoom,
      new google.maps.Size(0, 0)
    );

    for (var zoom = maxZoom; zoom >= minZoom; zoom--) {
      var cell = this.getGridCellCreate(gridPoint.x, gridPoint.y, zoom);
      cell.push(marker);

      gridPoint.x = gridPoint.x >> 1;
      gridPoint.y = gridPoint.y >> 1;
    }
  }

  /**
   * Returns whether or not the given point is visible in the shown bounds. This
   * is a helper method that takes care of the corner case, when shownBounds have
   * negative minX value.
   *
   * @param {Point} point a point on a grid.
   * @return {Boolean} Whether or not the given point is visible in the currently
   * shown bounds.
   */
  private isGridPointVisible(point: google.maps.Point): boolean {
    var vertical =
      this.shownBounds.minY <= point.y && point.y <= this.shownBounds.maxY;
    var minX = this.shownBounds.minX;
    var horizontal = minX <= point.x && point.x <= this.shownBounds.maxX;
    if (!horizontal && minX < 0) {
      // Shifts the negative part of the rectangle. As point.x is always less
      // than grid width, only test shifted minX .. 0 part of the shown bounds.
      var width = this.gridWidth[this.shownBounds.z];
      horizontal = minX + width <= point.x && point.x <= width - 1;
    }
    return vertical && horizontal;
  }

  /**
   * Reacts to a notification from a marker that it has moved to a new location.
   * It scans the grid all all zoom levels and moves the marker from the old grid
   * location to a new grid location.
   *
   * @param {Marker} marker The marker that moved.
   * @param {LatLng} oldPoint The old position of the marker.
   * @param {LatLng} newPoint The new position of the marker.
   */
  private onMarkerMoved(
    marker: google.maps.Marker,
    oldPoint: google.maps.LatLng,
    newPoint: google.maps.LatLng
  ) {
    // NOTE: We do not know the minimum or maximum zoom the marker was
    // added at, so we start at the absolute maximum. Whenever we successfully
    // remove a marker at a given zoom, we add it at the new grid coordinates.
    var zoom = this._maxZoom;
    var changed = false;
    var oldGrid = this.getTilePoint(oldPoint, zoom, new google.maps.Size(0, 0));
    var newGrid = this.getTilePoint(newPoint, zoom, new google.maps.Size(0, 0));
    while (zoom >= 0 && (oldGrid.x !== newGrid.x || oldGrid.y !== newGrid.y)) {
      var cell = this.getGridCellNoCreate(oldGrid.x, oldGrid.y, zoom);
      if (cell) {
        if (this.removeFromArray(cell, marker, false)) {
          this.getGridCellCreate(newGrid.x, newGrid.y, zoom).push(marker);
        }
      }
      // For the current zoom we also need to update the map. Markers that no
      // longer are visible are removed from the map. Markers that moved into
      // the shown bounds are added to the map. This also lets us keep the count
      // of visible markers up to date.
      if (zoom === this._mapZoom) {
        if (this.isGridPointVisible(oldGrid)) {
          if (!this.isGridPointVisible(newGrid)) {
            this.removeOverlay(marker);
            changed = true;
          }
        } else {
          if (this.isGridPointVisible(newGrid)) {
            this.addOverlay(marker);
            changed = true;
          }
        }
      }
      oldGrid.x = oldGrid.x >> 1;
      oldGrid.y = oldGrid.y >> 1;
      newGrid.x = newGrid.x >> 1;
      newGrid.y = newGrid.y >> 1;
      --zoom;
    }
    if (changed) {
      this.notifyListeners();
    }
  }

  /**
   * Removes marker from the manager and from the map
   * (if it's currently visible).
   * @param {GMarker} marker The marker to delete.
   */
  public removeMarker(marker: google.maps.Marker) {
    var zoom = this._maxZoom;
    var changed = false;
    var point = marker.getPosition();
    var grid = this.getTilePoint(point, zoom, new google.maps.Size(0, 0));
    while (zoom >= 0) {
      var cell = this.getGridCellNoCreate(grid.x, grid.y, zoom);

      if (cell) {
        this.removeFromArray(cell, marker, false);
      }
      // For the current zoom we also need to update the map. Markers that no
      // longer are visible are removed from the map. This also lets us keep the count
      // of visible markers up to date.
      if (zoom === this._mapZoom) {
        if (this.isGridPointVisible(grid)) {
          this.removeOverlay(marker);
          changed = true;
        }
      }
      grid.x = grid.x >> 1;
      grid.y = grid.y >> 1;
      --zoom;
    }
    if (changed) {
      this.notifyListeners();
    }
    this.numMarkers[marker.get("MarkerManager_minZoom")]--;
  }

  /**
   * Add many markers at once.
   * Does not actually update the map, just the internal grid.
   *
   * @param {Array of Marker} markers The markers to add.
   * @param {Number} minZoom The minimum zoom level to display the markers.
   * @param {Number} opt_maxZoom The maximum zoom level to display the markers.
   */
  public addMarkers(
    markers: google.maps.Marker[],
    minZoom: number,
    opt_maxZoom: number
  ) {
    var maxZoom = this.getOptmaxZoom(opt_maxZoom);
    for (var i = markers.length - 1; i >= 0; i--) {
      this.addMarkerBatch(markers[i], minZoom, maxZoom);
    }

    this.numMarkers[minZoom] += markers.length;
  }

  /**
   * Returns the value of the optional maximum zoom. This method is defined so
   * that we have just one place where optional maximum zoom is calculated.
   *
   * @param {Number} opt_maxZoom The optinal maximum zoom.
   * @return The maximum zoom.
   */
  getOptmaxZoom(opt_maxZoom: number): number {
    return opt_maxZoom || this._maxZoom;
  }

  /**
   * Calculates the total number of markers potentially visible at a given
   * zoom level.
   *
   * @param {Number} zoom The zoom level to check.
   */
  public getMarkerCount(zoom: number): number {
    var total = 0;
    for (var z = 0; z <= zoom; z++) {
      total += this.numMarkers[z];
    }
    return total;
  }

  /**
   * Returns a marker given latitude, longitude and zoom. If the marker does not
   * exist, the method will return a new marker. If a new marker is created,
   * it will NOT be added to the manager.
   *
   * @param {Number} lat - the latitude of a marker.
   * @param {Number} lng - the longitude of a marker.
   * @param {Number} zoom - the zoom level
   * @return {GMarker} marker - the marker found at lat and lng
   */
  public getMarker(lat: number, lng: number, zoom: number): google.maps.Marker {
    var mPoint = new google.maps.LatLng(lat, lng);
    var gridPoint = this.getTilePoint(mPoint, zoom, new google.maps.Size(0, 0));

    var marker = new google.maps.Marker({ position: mPoint });

    var cellArray = this.getGridCellNoCreate(gridPoint.x, gridPoint.y, zoom);
    if (cellArray !== undefined) {
      for (var i = 0; i < cellArray.length; i++) {
        if (
          lat === cellArray[i].getPosition().lat() &&
          lng === cellArray[i].getPosition().lng()
        ) {
          marker = cellArray[i];
        }
      }
    }
    return marker;
  }

  /**
   * Add a single marker to the map.
   *
   * @param {Marker} marker The marker to add.
   * @param {Number} minZoom The minimum zoom level to display the marker.
   * @param {Number} opt_maxZoom The maximum zoom level to display the marker.
   */
  public addMarker(marker: google.maps.Marker, minZoom: number, opt_maxZoom: number) {
    var maxZoom = this.getOptmaxZoom(opt_maxZoom);
    this.addMarkerBatch(marker, minZoom, maxZoom);
    var gridPoint = this.getTilePoint(
      marker.getPosition(),
      this._mapZoom,
      new google.maps.Size(0, 0)
    );
    if (
      this.isGridPointVisible(gridPoint) &&
      minZoom <= this.shownBounds.z &&
      this.shownBounds.z <= maxZoom
    ) {
      this.addOverlay(marker);
      this.notifyListeners();
    }
    this.numMarkers[minZoom]++;
  }

  /**
   * Get a cell in the grid, creating it first if necessary.
   *
   * Optimization candidate
   *
   * @param {Number} x The x coordinate of the cell.
   * @param {Number} y The y coordinate of the cell.
   * @param {Number} z The z coordinate of the cell.
   * @return {Array} The cell in the array.
   */
  private getGridCellCreate(x: number, y: number, z: number): google.maps.Marker[] {
    // TODO(jpoehnelt) document this
    if (x < 0) {
      x += this.gridWidth[z];
    }

    // TODO(jpoehnelt) Check that this functions correctly
    if (!this.grid[z]) {
      this.grid[z] = [];
    }
    if (!this.grid[z][x]) {
      this.grid[z][x] = [];
    }
    if (!this.grid[z][x][y]) {
      this.grid[z][x][y] = [];
    }
    return this.grid[z][x][y];
  }

  /**
   * Get a cell in the grid, returning undefined if it does not exist.
   *
   * NOTE: Optimized for speed -- otherwise could combine with getGridCellCreate.
   *
   * @param {Number} x The x coordinate of the cell.
   * @param {Number} y The y coordinate of the cell.
   * @param {Number} z The z coordinate of the cell.
   * @return {Array} The cell in the array.
   */
  private getGridCellNoCreate(x: number, y: number, z: number) {
    var grid = this.grid[z];

    if (x < 0) {
      x += this.gridWidth[z];
    }
    var gridCol = grid[x];
    return gridCol ? gridCol[y] : undefined;
  }

  /**
   * Turns at geographical bounds into a grid-space bounds.
   *
   * @param {LatLngBounds} bounds The geographical bounds.
   * @param {Number} zoom The zoom level of the bounds.
   * @param {google.maps.Size} swPadding The padding in pixels to extend beyond the
   * given bounds.
   * @param {google.maps.Size} nePadding The padding in pixels to extend beyond the
   * given bounds.
   * @return {GridBounds} The bounds in grid space.
   */
  private getGridBounds(
    bounds: google.maps.LatLngBounds,
    zoom: number,
    swPadding: google.maps.Size,
    nePadding: google.maps.Size
  ): GridBounds {
    zoom = Math.min(zoom, this._maxZoom);

    var bl = bounds.getSouthWest();
    var tr = bounds.getNorthEast();
    var sw = this.getTilePoint(bl, zoom, swPadding);

    var ne = this.getTilePoint(tr, zoom, nePadding);
    var gw = this.gridWidth[zoom];

    // Crossing the prime meridian requires correction of bounds.
    if (tr.lng() < bl.lng() || ne.x < sw.x) {
      sw.x -= gw;
    }
    if (ne.x - sw.x + 1 >= gw) {
      // Computed grid bounds are larger than the world; truncate.
      sw.x = 0;
      ne.x = gw - 1;
    }

    var gridBounds = new GridBounds([sw, ne], zoom);
    gridBounds.z = zoom;

    return gridBounds;
  }

  /**
   * Gets the grid-space bounds for the current map viewport.
   *
   * @return {Bounds} The bounds in grid space.
   */
  private getMapGridBounds(): GridBounds {
    return this.getGridBounds(
      this._map.getBounds(),
      this._mapZoom,
      this.swPadding,
      this.nePadding
    );
  }

  /**
   * Event listener for map:movend.
   * NOTE: Use a timeout so that the user is not blocked
   * from moving the map.
   *
   * Removed this because a a lack of a scopy override/callback function on events.
   */
  private onMapMoveEnd() {
    this.objectSetTimeout(this, this.updateMarkers.bind(this), 0);
  }

  /**
   * Call a function or evaluate an expression after a specified number of
   * milliseconds.
   *
   * Equivalent to the standard window.setTimeout function, but the given
   * function executes as a method of this instance. So the function passed to
   * objectSetTimeout can contain references to this.
   *    objectSetTimeout(this, function () { alert(this.x) }, 1000);
   *
   * @param {Object} object  The target object.
   * @param {Function} command  The command to run.
   * @param {Number} milliseconds  The delay.
   * @return {Boolean}  Success.
   */
  private objectSetTimeout(
    object: any,
    command: () => any,
    milliseconds: number
  ): number {
    return window.setTimeout(function() {
      command.call(object);
    }, milliseconds);
  }

  /**
   * Is this layer visible?
   *
   * Returns visibility setting
   *
   * @return {Boolean} Visible
   */
  public visible(): boolean {
    return this.shown ? true : false;
  }

  /**
   * Returns true if the manager is hidden.
   * Otherwise returns false.
   * @return {Boolean} Hidden
   */
  public isHidden(): boolean {
    return !this.shown;
  }

  /**
   * Shows the manager if it's currently hidden.
   */
  public show() {
    this.shown = true;
    this.refresh();
  }

  /**
   * Hides the manager if it's currently visible
   */
  public hide() {
    this.shown = false;
    this.refresh();
  }

  /**
   * Toggles the visibility of the manager.
   */
  public toggle() {
    this.shown = !this.shown;
    this.refresh();
  }

  /**
   * Refresh forces the marker-manager into a good state.
   * <ol>
   *   <li>If never before initialized, shows all the markers.</li>
   *   <li>If previously initialized, removes and re-adds all markers.</li>
   * </ol>
   */
  public refresh() {
    if (this.shownMarkers > 0) {
      this.processAll(this.shownBounds, this.removeOverlay.bind(this));
    }
    // An extra check on this.show to increase performance (no need to processAll_)
    if (this.show) {
      this.processAll(this.shownBounds, this.addOverlay.bind(this));
    }
    this.notifyListeners();
  }

  /**
   * After the viewport may have changed, add or remove markers as needed.
   */
  private updateMarkers() {
    this._mapZoom = this._map.getZoom();
    var newBounds = this.getMapGridBounds();

    // If the move does not include new grid sections,
    // we have no work to do:
    if (
      newBounds.equals(this.shownBounds) &&
      newBounds.z === this.shownBounds.z
    ) {
      return;
    }

    if (newBounds.z !== this.shownBounds.z) {
      this.processAll(this.shownBounds, this.removeOverlay.bind(this));
      if (this.show) {
        // performance
        this.processAll(newBounds, this.addOverlay.bind(this));
      }
    } else {
      // Remove markers:
      this.rectangleDiff(
        this.shownBounds,
        newBounds,
        this.removeCellMarkers.bind(this)
      );

      // Add markers:
      if (this.show) {
        // performance
        this.rectangleDiff(
          newBounds,
          this.shownBounds,
          this.addCellMarkers.bind(this)
        );
      }
    }
    this.shownBounds = newBounds;

    this.notifyListeners();
  }

  /**
   * Notify listeners when the state of what is displayed changes.
   */
  private notifyListeners() {
    google.maps.event.trigger(
      this,
      "changed",
      this.shownBounds,
      this.shownMarkers
    );
  }

  /**
   * Process all markers in the bounds provided, using a callback.
   *
   * @param {Bounds} bounds The bounds in grid space.
   * @param {Function} callback The function to call for each marker.
   */
  private processAll(
    bounds: GridBounds,
    callback: (marker: google.maps.Marker) => void
  ) {
    for (var x = bounds.minX; x <= bounds.maxX; x++) {
      for (var y = bounds.minY; y <= bounds.maxY; y++) {
        this.processCellMarkers(x, y, bounds.z, callback);
      }
    }
  }

  /**
   * Process all markers in the grid cell, using a callback.
   *
   * @param {Number} x The x coordinate of the cell.
   * @param {Number} y The y coordinate of the cell.
   * @param {Number} z The z coordinate of the cell.
   * @param {Function} callback The function to call for each marker.
   */
  private processCellMarkers(
    x: number,
    y: number,
    z: number,
    callback: (marker: google.maps.Marker) => void
  ) {
    var cell = this.getGridCellNoCreate(x, y, z);
    if (cell) {
      for (var i = cell.length - 1; i >= 0; i--) {
        callback(cell[i]);
      }
    }
  }

  /**
   * Remove all markers in a grid cell.
   *
   * @param {Number} x The x coordinate of the cell.
   * @param {Number} y The y coordinate of the cell.
   * @param {Number} z The z coordinate of the cell.
   */
  private removeCellMarkers(x: number, y: number, z: number) {
    this.processCellMarkers(x, y, z, this.removeOverlay.bind(this));
  }

  /**
   * Add all markers in a grid cell.
   *
   * @param {Number} x The x coordinate of the cell.
   * @param {Number} y The y coordinate of the cell.
   * @param {Number} z The z coordinate of the cell.
   */
  private addCellMarkers(x: number, y: number, z: number) {
    this.processCellMarkers(x, y, z, this.addOverlay.bind(this));
  }

  /**
   * Use the rectangleDiffCoords function to process all grid cells
   * that are in bounds1 but not bounds2, using a callback, and using
   * the current MarkerManager object as the instance.
   *
   * Pass the z parameter to the callback in addition to x and y.
   *
   * @param {Bounds} bounds1 The bounds of all points we may process.
   * @param {Bounds} bounds2 The bounds of points to exclude.
   * @param {Function} callback The callback function to call
   *                   for each grid coordinate (x, y, z).
   */
  private rectangleDiff(
    bounds1: GridBounds,
    bounds2: GridBounds,
    callback: (x: number, y: number, z: number) => void
  ) {
    var me = this;
    this.rectangleDiffCoords(bounds1, bounds2, function(x, y) {
      callback(x, y, bounds1.z);
    });
  }

  /**
   * Calls the function for all points in bounds1, not in bounds2
   *
   * @param {Bounds} bounds1 The bounds of all points we may process.
   * @param {Bounds} bounds2 The bounds of points to exclude.
   * @param {Function} callback The callback function to call
   *                   for each grid coordinate.
   */
  private rectangleDiffCoords(
    bounds1: GridBounds,
    bounds2: GridBounds,
    callback: (x: number, y: number) => void
  ) {
    var minX1 = bounds1.minX;
    var minY1 = bounds1.minY;
    var maxX1 = bounds1.maxX;
    var maxY1 = bounds1.maxY;
    var minX2 = bounds2.minX;
    var minY2 = bounds2.minY;
    var maxX2 = bounds2.maxX;
    var maxY2 = bounds2.maxY;

    var x, y;
    for (x = minX1; x <= maxX1; x++) {
      // All x in R1
      // All above:
      for (y = minY1; y <= maxY1 && y < minY2; y++) {
        // y in R1 above R2
        callback(x, y);
      }
      // All below:
      for (
        y = Math.max(maxY2 + 1, minY1); // y in R1 below R2
        y <= maxY1;
        y++
      ) {
        callback(x, y);
      }
    }

    for (y = Math.max(minY1, minY2); y <= Math.min(maxY1, maxY2); y++) {
      // All y in R2 and in R1
      // Strictly left:
      for (x = Math.min(maxX1 + 1, minX2) - 1; x >= minX1; x--) {
        // x in R1 left of R2
        callback(x, y);
      }
      // Strictly right:
      for (
        x = Math.max(minX1, maxX2 + 1); // x in R1 right of R2
        x <= maxX1;
        x++
      ) {
        callback(x, y);
      }
    }
  }

  /**
   * Removes value from array. O(N).
   *
   * @param {Array} array  The array to modify.
   * @param {any} value  The value to remove.
   * @param {Boolean} opt_notype  Flag to disable type checking in equality.
   * @return {Number}  The number of instances of value that were removed.
   */
  private removeFromArray(array: any[], value: any, opt_notype: boolean): number {
    var shift = 0;
    for (var i = 0; i < array.length; ++i) {
      if (array[i] === value || (opt_notype && array[i] === value)) {
        array.splice(i--, 1);
        shift++;
      }
    }
    return shift;
  }
}
/**
 * Helper class to create a bounds of INT ranges.
 * @param bounds Array.<Object.<string, number>> Bounds object.
 * @constructor
 */
class GridBounds {
  public z: number;
  public minX: number;
  public maxX: number;
  public minY: number;
  public maxY: number;

  constructor(bounds: google.maps.Point[], z: number) {
    // [sw, ne]
    this.z = z;
    this.minX = Math.min(bounds[0].x, bounds[1].x);
    this.maxX = Math.max(bounds[0].x, bounds[1].x);
    this.minY = Math.min(bounds[0].y, bounds[1].y);
    this.maxY = Math.max(bounds[0].y, bounds[1].y);
  }

  /**
   * Returns true if this bounds equal the given bounds.
   * @param {GridBounds} gridBounds GridBounds The bounds to test.
   * @return {Boolean} This Bounds equals the given GridBounds.
   */
  equals(gridBounds: GridBounds): boolean {
    if (
      this.maxX === gridBounds.maxX &&
      this.maxY === gridBounds.maxY &&
      this.minX === gridBounds.minX &&
      this.minY === gridBounds.minY
    ) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Returns true if this bounds (inclusively) contains the given point.
   * @param {Point} point  The point to test.
   * @return {Boolean} This Bounds contains the given Point.
   */
  containsPoint(point: google.maps.Point): boolean {
    return (
      this.minX <= point.x &&
      this.maxX >= point.x &&
      this.minY <= point.y &&
      this.maxY >= point.y
    );
  }
}

function latLngToPixel(
  latlng: google.maps.LatLng,
  zoom: number
): google.maps.Point {
  return new google.maps.Point(
    ~~(0.5 + lngToX(latlng.lng()) * (2 << (zoom + 6))),
    ~~(0.5 + latToY(latlng.lat()) * (2 << (zoom + 6)))
  );
}

function lngToX(lng: number): number {
  return 1 + lng / 180;
}

function latToY(lat: number): number {
  var sinofphi = Math.sin((lat * Math.PI) / 180);
  return 1 - (0.5 / Math.PI) * Math.log((1 + sinofphi) / (1 - sinofphi));
}

export { MarkerManager };
