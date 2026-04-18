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
  advice?: string; // 食事区分ごとのアドバイス（朝/昼/夕のみ）
}

export interface DailyMeals {
  date: string;
  foods: FoodEntry[];
  meals: MealSummary[];
  dailyAdvice?: string; // 1日全体の食事アドバイス
}
