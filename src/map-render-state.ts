export interface MapRenderState {
  flatBuildings: boolean;
  extrusions: boolean;
  trees: boolean;
  keyOnly: boolean;
  selectedId: string | undefined;
}

export interface MapRenderStateTarget {
  setVisibility(layerId: string, visible: boolean): void;
  setKeyOnly(keyOnly: boolean): void;
  setSelectedBuildingColor(layerId: 'buildings-flat' | 'buildings-3d', selectedId: string | undefined): void;
}

export function mapRenderState(
  pitch: number,
  buildingsVisible: boolean,
  showAllBuildings: boolean,
  selectedId: string | undefined,
): MapRenderState {
  const extrusions = buildingsVisible && pitch >= 10;
  return {
    flatBuildings: buildingsVisible,
    extrusions,
    trees: extrusions,
    keyOnly: !showAllBuildings,
    selectedId,
  };
}

export function applyMapRenderState(target: MapRenderStateTarget, state: MapRenderState): void {
  target.setVisibility('building-shadows-low', state.flatBuildings);
  target.setVisibility('building-shadows-high', state.flatBuildings);
  target.setVisibility('buildings-flat', state.flatBuildings);
  target.setVisibility('buildings-3d', state.extrusions);
  target.setVisibility('trees-3d', state.trees);
  target.setKeyOnly(state.keyOnly);
  target.setSelectedBuildingColor('buildings-flat', state.selectedId);
  target.setSelectedBuildingColor('buildings-3d', state.selectedId);
}
