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

export async function loadBasicInfo(): Promise<{ goalWeight?: number; weightUnit?: string }> {
  try {
    const raw = await AsyncStorage.getItem(BASIC_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export async function saveBasicInfo(info: { goalWeight?: number; weightUnit?: string }): Promise<void> {
  try {
    const existing = await loadBasicInfo();
    await AsyncStorage.setItem(BASIC_KEY, JSON.stringify({ ...existing, ...info }));
  } catch {}
}
