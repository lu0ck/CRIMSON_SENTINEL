// TSP (Traveling Salesman Problem) para roteirização de compras (FASE 5).
// Nearest-neighbor a partir do ponto inicial + melhoria 2-opt (determinístico,
// suficiente para ≤ ~15 paradas — route_max_stops).

export interface TspResult {
  order: number[]; // índices começando pelo start (0)
  distanceKm: number; // distância do caminho (não fecha o ciclo)
}

// Distância do caminho na ordem dada (soma das arestas consecutivas, sem
// voltar ao início).
function pathDistance(order: number[], matrix: number[][]): number {
  let d = 0;
  for (let i = 0; i < order.length - 1; i++) {
    d += matrix[order[i]][order[i + 1]];
  }
  return d;
}

export function nearestNeighbor(startIdx: number, matrix: number[][]): number[] {
  const n = matrix.length;
  if (n === 0) return [];
  const visited = new Array<boolean>(n).fill(false);
  const order = [startIdx];
  visited[startIdx] = true;
  let current = startIdx;

  while (order.length < n) {
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < n; j++) {
      if (!visited[j] && matrix[current][j] < bestDist) {
        bestDist = matrix[current][j];
        best = j;
      }
    }
    if (best === -1) {
      // remaining unvisited nodes are unreachable (Infinity distance);
      // append them anyway so none are dropped from the route.
      for (let j = 0; j < n; j++) {
        if (!visited[j]) {
          visited[j] = true;
          order.push(j);
        }
      }
      break;
    }
    visited[best] = true;
    order.push(best);
    current = best;
  }
  return order;
}

// 2-opt: reverte segmentos quando reduz a distância. Roda até estabilizar.
export function twoOpt(order: number[], matrix: number[][]): number[] {
  let best = order.slice();
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = best.slice();
        const segment = candidate.splice(i, j - i + 1).reverse();
        candidate.splice(i, 0, ...segment);
        if (pathDistance(candidate, matrix) < pathDistance(best, matrix) - 1e-9) {
          best = candidate;
          improved = true;
        }
      }
    }
  }
  return best;
}

// Resolve o TSP para a matriz completa. startIdx = índice do ponto de partida
// (tipicamente 0). Retorna a ordem ótima e a distância do caminho.
export function solveTsp(matrix: number[][], startIdx = 0): TspResult {
  if (matrix.length === 0) return { order: [], distanceKm: 0 };
  if (matrix.length === 1) return { order: [startIdx], distanceKm: 0 };
  const nn = nearestNeighbor(startIdx, matrix);
  const order = twoOpt(nn, matrix);
  return { order, distanceKm: pathDistance(order, matrix) };
}
