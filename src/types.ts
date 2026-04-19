export type MealDivision = '朝食' | '昼食' | '夕食' | '間食';

export interface FoodEntry {
  division: MealDivision;
  name: string;
  quantity: string;
  calories: number;
}

export interface MealSummary {
  division: MealDivision;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number;
  advice?: string;
}

export interface DailyMeals {
  date: string;
  foods: FoodEntry[];
  meals: MealSummary[];
  dailyAdvice?: string;
}

// ---- Apple Health Export ----

/** export.xml から日別に集計した健康データ */
export interface DailyHealth {
  date: string;                   // YYYY-MM-DD (JST)
  bodyMass?: number;              // kg (最新値)
  bodyFat?: number;               // 小数 e.g. 0.22 = 22% (最新値)
  leanBodyMass?: number;          // kg (最新値)
  steps?: number;                 // 合計歩数
  distanceKm?: number;            // 歩行・走行距離 km (合計)
  basalCalories?: number;         // 安静時消費カロリー kcal (合計)
  avgHeartRate?: number;          // 平均心拍数 bpm
  avgRespiratoryRate?: number;    // 平均呼吸数 breath/min
  avgOxygenSaturation?: number;   // 平均血中酸素 % (0-100)
}

/** HRV の 1 サンプル（SDNN 値） */
export interface HrvSample {
  startDate: string;  // ISO8601 (HealthKit startDate そのまま)
  sdnn: number;       // ms
  source: string;     // ソース名
}

/** parse-health-export.ts の stdout JSON 型 */
export interface HealthExport {
  dailies: DailyHealth[];
  hrv: HrvSample[];
}
