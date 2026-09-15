import AsyncStorage from '@react-native-async-storage/async-storage';
import { stampLegacyUnits, type WeightUnit } from '@/lib/weightUnit';

export interface WeightEntry {
  date: string;
  /** As typed, in `unit`. Show it with weightLogInUnit (lib/weightUnit.ts). */
  weight: number;
  /** Missing only on entries saved before units were recorded; loadWeightLog fills it. */
  unit?: WeightUnit;
}

export interface BodyFatEntry {
  date: string;
  bodyFat: number;
}

export interface MeasurementEntry {
  id: string;
  date: string;
  chest?: number;
  shoulders?: number;
  neck?: number;
  bicepL?: number;
  bicepR?: number;
  forearmL?: number;
  forearmR?: number;
  waist?: number;
  hips?: number;
  thighL?: number;
  thighR?: number;
  calfL?: number;
  calfR?: number;
}

export interface MeasurementsData {
  entries: MeasurementEntry[];
  unit: 'cm' | 'in';
}

const WEIGHT_KEY = 'overload_weight_log';
const BF_KEY = 'overload_bodyfat_log';
const MEASUREMENTS_KEY = 'overload_measurements';
const BASIC_KEY = 'overload_basic_info';

export async function loadWeightLog(): Promise<WeightEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(WEIGHT_KEY);
    if (!raw) return [];
    // Old entries carry no unit. Give them the saved unit once and write that
    // back, so a later kg/lbs switch converts them instead of relabeling them.
    const info = await loadBasicInfo();
    const { log, changed } = stampLegacyUnits<WeightEntry>(JSON.parse(raw), info.weightUnit === 'lbs' ? 'lbs' : 'kg');
    if (changed) await AsyncStorage.setItem(WEIGHT_KEY, JSON.stringify(log)).catch(() => {});
    return log;
  } catch {
    return [];
  }
}

export async function saveWeightLog(log: WeightEntry[]): Promise<void> {
  await AsyncStorage.setItem(WEIGHT_KEY, JSON.stringify(log));
}

export async function loadBodyFatLog(): Promise<BodyFatEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(BF_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveBodyFatLog(log: BodyFatEntry[]): Promise<void> {
  await AsyncStorage.setItem(BF_KEY, JSON.stringify(log));
}

export async function loadMeasurements(): Promise<MeasurementsData> {
  try {
    const raw = await AsyncStorage.getItem(MEASUREMENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) return parsed;
    }
  } catch {}
  return { entries: [], unit: 'cm' };
}

export async function saveMeasurements(d: MeasurementsData): Promise<void> {
  await AsyncStorage.setItem(MEASUREMENTS_KEY, JSON.stringify(d));
}

export async function loadBasicInfo(): Promise<{ goalWeight?: number | null; weightUnit?: string }> {
  try {
    const raw = await AsyncStorage.getItem(BASIC_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveBasicInfo(info: { goalWeight?: number | null; weightUnit?: string }): Promise<void> {
  try {
    const existing = await loadBasicInfo();
    await AsyncStorage.setItem(BASIC_KEY, JSON.stringify({ ...existing, ...info }));
  } catch {}
}
