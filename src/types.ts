export type MealDivision = '朝食' | '昼食' | '夕食' | '間食';

export interface FoodEntry {
  division: MealDivision;
  name: string;
  grams: number;
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
  fiber: number;
}

export interface DailyMeals {
  date: string; // "YYYY-MM-DD"
  entries: FoodEntry[];
}
