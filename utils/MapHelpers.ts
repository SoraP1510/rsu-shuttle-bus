import L from "leaflet";

type Coordinate = [number, number];

export function shouldMove(oldPos: Coordinate, newPos: Coordinate): boolean {
  const dx = oldPos[0] - newPos[0];
  const dy = oldPos[1] - newPos[1];
  return Math.sqrt(dx * dx + dy * dy) > 0.00003;
}

export function animateMove(marker: L.Marker, start: Coordinate, end: Coordinate, duration: number = 800) {
  const startTime = performance.now();
  function step(currentTime: number) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    const lat = start[0] + (end[0] - start[0]) * progress;
    const lng = start[1] + (end[1] - start[1]) * progress;
    
    marker.setLatLng([lat, lng]);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

export function getNearestPointIndex(pos: Coordinate, coords: Coordinate[]): number {
  let minDst = Infinity;
  let minIdx = 0;
  const pt = L.latLng(pos[0], pos[1]);
  
  for (let i = 0; i < coords.length; i++) {
    const dst = pt.distanceTo(L.latLng(coords[i][0], coords[i][1]));
    if (dst < minDst) {
      minDst = dst;
      minIdx = i;
    }
  }
  return minIdx;
}