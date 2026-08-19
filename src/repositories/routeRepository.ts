import { getDb } from "../database/db";
import type { RoutePlan } from "../types";
import { type RouteRow, type RouteStopRow, routeRowToRoutePlan } from "./types";

export const RouteRepository = {
  getAll(): RoutePlan[] {
    const rows = getDb()
      .prepare("SELECT * FROM routes ORDER BY created_at DESC")
      .all() as RouteRow[];
    return rows.map((r) => this.getWithStops(r));
  },

  getById(id: string): RoutePlan | undefined {
    const row = getDb()
      .prepare("SELECT * FROM routes WHERE id = ?")
      .get(id) as RouteRow | undefined;
    return row ? this.getWithStops(row) : undefined;
  },

  // Só existe para evitar duplicação de leitura de stops; não exporta como API pública.
  getWithStops(row: RouteRow): RoutePlan {
    const stops = getDb()
      .prepare("SELECT * FROM route_stops WHERE route_id = ?")
      .all(row.id) as RouteStopRow[];
    return routeRowToRoutePlan(row, stops);
  },

  save(route: RoutePlan): void {
    const db = getDb();
    const tx = db.transaction((r: RoutePlan) => {
      db.prepare(
        `INSERT INTO routes (id, name, start_lat, start_lng, total_distance_km, total_estimated_cost, route_data, vehicle_type, total_time_min, suggested_departure_at, travel_cost, fuel_consumption_km_l, fuel_price_per_l)
         VALUES (@id, @name, @start_lat, @start_lng, @total_distance_km, @total_estimated_cost, @route_data, @vehicle_type, @total_time_min, @suggested_departure_at, @travel_cost, @fuel_consumption_km_l, @fuel_price_per_l)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, start_lat=excluded.start_lat, start_lng=excluded.start_lng,
           total_distance_km=excluded.total_distance_km,
           total_estimated_cost=excluded.total_estimated_cost,
           route_data=excluded.route_data,
           vehicle_type=excluded.vehicle_type, total_time_min=excluded.total_time_min,
           suggested_departure_at=excluded.suggested_departure_at, travel_cost=excluded.travel_cost,
           fuel_consumption_km_l=excluded.fuel_consumption_km_l, fuel_price_per_l=excluded.fuel_price_per_l`
      ).run({
        id: r.id,
        name: r.name ?? null,
        start_lat: r.startLat,
        start_lng: r.startLng,
        total_distance_km: r.totalDistanceKm ?? null,
        total_estimated_cost: r.totalEstimatedCost ?? null,
        route_data: JSON.stringify({
          stops: r.stops.map((s) => ({
            establishmentId: s.establishmentId,
            stopOrder: s.stopOrder,
            arrivalTimeEstimate: s.arrivalTimeEstimate,
            quietScore: s.quietScore,
          })),
        }),
        vehicle_type: r.vehicleType ?? null,
        total_time_min: r.totalTimeMin ?? null,
        suggested_departure_at: r.suggestedDepartureAt ?? null,
        travel_cost: r.travelCost ?? null,
        fuel_consumption_km_l: r.fuelConsumptionKmPerL ?? null,
        fuel_price_per_l: r.fuelPricePerL ?? null,
      });

      db.prepare("DELETE FROM route_stops WHERE route_id = ?").run(r.id);
      const stmt = db.prepare(
        `INSERT INTO route_stops (route_id, establishment_id, stop_order, estimated_cost, items, arrival_time_estimate, quiet_score)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const s of r.stops) {
        stmt.run(
          r.id,
          s.establishmentId,
          s.stopOrder,
          s.estimatedCost ?? null,
          s.items ? JSON.stringify(s.items) : null,
          s.arrivalTimeEstimate ?? null,
          s.quietScore ?? null
        );
      }
    });
    tx(route);
  },

  delete(id: string): void {
    getDb().prepare("DELETE FROM routes WHERE id = ?").run(id);
  },
};
