import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';
import { loadBasicInfo, saveBasicInfo } from '@/lib/bodyStats';

type WeightUnit = 'kg' | 'lbs';

interface BasicInfoContextType {
  goalWeight: number | null;
  weightUnit: WeightUnit;
  ready: boolean;
  setGoalWeight: (v: number | null) => void;
  setWeightUnit: (u: WeightUnit) => void;
}

const BasicInfoContext = createContext<BasicInfoContextType>({
  goalWeight: null,
  weightUnit: 'kg',
  ready: false,
  setGoalWeight: () => {},
  setWeightUnit: () => {},
});

export function BasicInfoProvider({ children }: { children: ReactNode }) {
  const [goalWeight, setGoalWeightState] = useState<number | null>(null);
  const [weightUnit, setWeightUnitState] = useState<WeightUnit>('kg');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadBasicInfo()
      .then((info) => {
        if (typeof info.goalWeight === 'number') setGoalWeightState(info.goalWeight);
        if (info.weightUnit === 'kg' || info.weightUnit === 'lbs') setWeightUnitState(info.weightUnit);
      })
      .finally(() => setReady(true));
  }, []);

  const setGoalWeight = useCallback((v: number | null) => {
    setGoalWeightState(v);
    if (v !== null) saveBasicInfo({ goalWeight: v });
  }, []);

  const setWeightUnit = useCallback((u: WeightUnit) => {
    setWeightUnitState(u);
    saveBasicInfo({ weightUnit: u });
  }, []);

  return (
    <BasicInfoContext.Provider value={{ goalWeight, weightUnit, ready, setGoalWeight, setWeightUnit }}>
      {children}
    </BasicInfoContext.Provider>
  );
}

export function useBasicInfo() {
  return useContext(BasicInfoContext);
}
