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
}

export interface DailyMeals {
  date: string;
  foods: FoodEntry[];
  meals: MealSummary[];
}
