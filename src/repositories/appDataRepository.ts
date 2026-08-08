import type { AppData } from "../types";
import { getDb } from "../database/db";
import { ProfileRepository } from "./profileRepository";
import { ProductListRepository } from "./productListRepository";
import { ProductRepository } from "./productRepository";

export const AppDataRepository = {
  getAll(): AppData {
    return {
      profiles: ProfileRepository.getAll(),
      lists: ProductListRepository.getAll(),
      products: ProductRepository.getAll(),
    };
  },

  saveAll(data: AppData): void {
    const db = getDb();
    const tx = db.transaction(() => {
      ProfileRepository.saveAll(data.profiles);
      ProductListRepository.saveAll(data.lists);
      ProductRepository.saveAll(data.products);
    });
    tx();
  },
};
