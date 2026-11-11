// Release-ladder calibration plate: five blocks of growing footprint along the front of the active plate.
import { centreMesh } from '../../io/load';
import { openEdgeCount } from '../../engine/mesh';
import { primitive } from '../../state/ops';
import { newId, objectPlate, plateOrigin, useStore, type SceneObject } from '../../state/store';
import { CALIBRATION_BLOCKS, CALIBRATION_FRONT_Y, CALIBRATION_HEIGHT } from './model';

/** Replaces the active plate's objects with the ladder (undoable). Returns the blocks placed. */
export function addCalibrationPlate(): number {
  const s = useStore.getState();
  const plate = s.activePlate;
  const [ox, oy] = plateOrigin(plate, s.printerId);
  const blocks: SceneObject[] = CALIBRATION_BLOCKS.map((b) => {
    const mesh = primitive('box', 1);
    centreMesh(mesh);
    return {
      id: newId(), name: `Ladder ${b.label} (${b.side * b.side} mm²)`, mesh, rotation: [0, 0, 0], scale: [b.side, b.side, CALIBRATION_HEIGHT],
      position: [ox + b.x, oy + CALIBRATION_FRONT_Y + b.side / 2, 0], openEdges: openEdgeCount(mesh),
    };
  });
  s.checkpoint();
  useStore.setState((st) => ({ objects: [...st.objects.filter((o) => objectPlate(o, st.printerId, st.plates.length) !== plate), ...blocks], selected: [] }));
  s.markDirty();
  return blocks.length;
}
