import type { DeviceInventory, DeviceSummary } from '../../shared/types';
import type { DevicePrefs } from '../config/userPrefsStore';

type Role = keyof DevicePrefs;
const INPUT_ROLES: readonly Role[] = ['mic', 'fromMeet'];
const OUTPUT_ROLES: readonly Role[] = ['toMeet', 'headset'];

export interface ReconcileResult {
  devices: DevicePrefs;
  /** Device id → label, for the ids in `devices` that are present now. */
  labels: Record<string, string>;
  /** Roles whose saved id was gone and was re-found by its label. */
  remapped: Role[];
  /** True when `devices` or `labels` differ from what was saved. */
  changed: boolean;
}

function present(inv: DeviceInventory): { inputs: DeviceSummary[]; outputs: DeviceSummary[] } {
  const inputs = [...inv.inputs];
  const outputs = [...inv.outputs];
  for (const cable of [inv.cableA, inv.cableB]) {
    if (cable?.recording) inputs.push(cable.recording);
    if (cable?.playback) outputs.push(cable.playback);
  }
  return { inputs, outputs };
}

/**
 * Keeps the saved device choices valid across app updates, driver reinstalls and Windows
 * re-enumerations, all of which can change a device's id. Every saved id remembers its
 * label; when an id disappears but exactly one present device has that label, the choice
 * moves to it. A label shared by several devices is ambiguous and left alone.
 */
export function reconcileDevices(
  devices: DevicePrefs,
  savedLabels: Record<string, string> | undefined,
  inventory: DeviceInventory,
): ReconcileResult {
  const lists = present(inventory);
  const out: DevicePrefs = { ...devices };
  const labels: Record<string, string> = {};
  const remapped: Role[] = [];

  const visit = (role: Role, list: DeviceSummary[]): void => {
    const id = devices[role];
    if (!id) return;
    const here = list.find((d) => d.deviceId === id);
    if (here) {
      if (here.label) labels[id] = here.label;
      return;
    }
    const label = savedLabels?.[id];
    if (!label) return;
    const matches = list.filter((d) => d.label === label);
    if (matches.length !== 1) {
      labels[id] = label; // keep it: the device may come back
      return;
    }
    const next = matches[0]!.deviceId;
    out[role] = next;
    labels[next] = label;
    remapped.push(role);
  };
  for (const role of INPUT_ROLES) visit(role, lists.inputs);
  for (const role of OUTPUT_ROLES) visit(role, lists.outputs);

  const changed =
    remapped.length > 0 || JSON.stringify(labels) !== JSON.stringify(savedLabels ?? {});
  return { devices: out, labels, remapped, changed };
}
