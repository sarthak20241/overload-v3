import AsyncStorage from '@react-native-async-storage/async-storage';

export interface WeightEntry {
  date: string;
  weight: number;
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
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// The device logs below are for guests. A signed-in user's weight, body fat
// and measurements live on the server (lib/bodyLogSync.ts); these logs are
// uploaded to the account once and then cleared.
export async function saveWeightLog(log: WeightEntry[]): Promise<void> {
  await AsyncStorage.setItem(WEIGHT_KEY, JSON.stringify(log));
}

export async function clearWeightLog(): Promise<void> {
  await AsyncStorage.removeItem(WEIGHT_KEY);
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

export async function clearBodyFatLog(): Promise<void> {
  await AsyncStorage.removeItem(BF_KEY);
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

/** Drop the device's measurement entries once uploaded, keeping the cm/in choice. */
export async function clearMeasurementEntries(): Promise<void> {
  const { unit } = await loadMeasurements();
  await saveMeasurements({ entries: [], unit });
}

/** Save only the cm/in choice, keeping any device entries. */
export async function saveMeasurementUnit(unit: 'cm' | 'in'): Promise<void> {
  const current = await loadMeasurements();
  await saveMeasurements({ ...current, unit });
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
