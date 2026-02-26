"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import { io, Socket } from "socket.io-client";
import "leaflet/dist/leaflet.css";

import { RSU_CENTER } from "../constants";
import { useLeafletMap } from "../hooks/useLeafletMap";
import AvailabilityCard from "./AvailabilityCard";
import StopInfoCard from "./StopInfoCard";
import { shouldMove, animateMove, getNearestPointIndex } from "../utils/MapHelpers";
import { Stop, Vehicle, LocationUpdateData } from "../types";

export default function ShuttleTracker() {
  const { mapRef, LRef } = useLeafletMap();

  const [selectedRoute, setSelectedRoute] = useState<string>("R01");
  const [availableCount, setAvailableCount] = useState<number>(0);
  
  const [userLoc, setUserLoc] = useState<[number, number] | null>(null);
  const [targetStop, setTargetStop] = useState<Stop | null>(null);
  const [realEta, setRealEta] = useState<number | null>(null);

  const selectedRouteRef = useRef<string>("R01"); 
  const targetStopRef = useRef<Stop | null>(null);
  const stopsByRouteRef = useRef<Record<string, Stop[]>>({});
  const routeGeometryRef = useRef<Record<string, [number, number][]>>({}); 

  const vehiclesRef = useRef<Record<string, L.Marker>>({});
  const prevPositionsRef = useRef<Record<string, [number, number]>>({});
  const vehicleSpeedsRef = useRef<Record<string, number>>({}); 
  const routeLayersRef = useRef<Record<string, L.LayerGroup>>({});
  const stopLayersRef = useRef<Record<string, L.LayerGroup>>({});
  const vehicleRouteMapRef = useRef<Record<string, string>>({});
  const userMarkerRef = useRef<L.Marker | null>(null);

  /* === ETA Calculation === */
  const calculateETA = useCallback(() => {
    if (!targetStopRef.current || !mapRef.current) {
      setRealEta(null);
      return;
    }

    const stop = targetStopRef.current;
    const routeId = selectedRouteRef.current;
    const stopLatLng = L.latLng(stop.lat, stop.lng);
    const coords = routeGeometryRef.current[routeId];
    
    let minEtaMinutes = Infinity;
    
    Object.keys(vehiclesRef.current).forEach(id => {
      const route = vehicleRouteMapRef.current[id];
      const marker = vehiclesRef.current[id];
      
      if (route === routeId && mapRef.current?.hasLayer(marker)) {
        const pos = prevPositionsRef.current[id];
        if (pos) {
          const busLatLng = L.latLng(pos[0], pos[1]);
          const straightDist = stopLatLng.distanceTo(busLatLng);
          
          let pathDist = straightDist;

          if (straightDist < 50) {
            pathDist = straightDist;
          } else if (coords && coords.length > 0) {
            const busIdx = getNearestPointIndex(pos, coords);
            const stopIdx = getNearestPointIndex([stop.lat, stop.lng], coords);
            
            pathDist = 0;
            if (busIdx <= stopIdx) {
              for (let i = busIdx; i < stopIdx; i++) {
                pathDist += L.latLng(coords[i]).distanceTo(L.latLng(coords[i+1]));
              }
            } else {
              for (let i = busIdx; i < coords.length - 1; i++) {
                pathDist += L.latLng(coords[i]).distanceTo(L.latLng(coords[i+1]));
              }
              for (let i = 0; i < stopIdx; i++) {
                pathDist += L.latLng(coords[i]).distanceTo(L.latLng(coords[i+1]));
              }
            }
          }

          let speedKmh = vehicleSpeedsRef.current[id];
          if (speedKmh === undefined || speedKmh === null) speedKmh = 15;
          if (speedKmh < 5) speedKmh = 5;

          const speedMpm = speedKmh * (1000 / 60);
          const etaMinutes = Math.floor(pathDist / speedMpm);

          if (etaMinutes < minEtaMinutes) minEtaMinutes = etaMinutes;
        }
      }
    });

    setRealEta(minEtaMinutes === Infinity ? null : minEtaMinutes);
  }, []);

  const updateAvailableCount = useCallback(() => {
    if (!mapRef.current) return;
    let count = 0;
    Object.values(vehiclesRef.current).forEach(marker => {
      if (mapRef.current?.hasLayer(marker)) count++;
    });
    setAvailableCount(count);
    calculateETA(); 
  }, [calculateETA]);

  /* === GPS Tracking === */
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (pos: GeolocationPosition) => {
        const coords: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        setUserLoc(coords);
        if (!mapRef.current) return;
        
        if (!userMarkerRef.current) {
          const userIcon = L.divIcon({
            className: "user-loc-marker",
            html: `<div class="user-pulse"></div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          });
          userMarkerRef.current = L.marker(coords, { icon: userIcon }).addTo(mapRef.current);
        } else {
          userMarkerRef.current.setLatLng(coords);
        }
      },
      (err: GeolocationPositionError) => console.log("GPS Error:", err),
      { enableHighAccuracy: true }
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, [mapRef]);

  const handleFindNearestStop = () => {
    if (!userLoc) {
      alert("กรุณาเปิดการเข้าถึงตำแหน่งที่ตั้ง (GPS) ในเบราว์เซอร์ของคุณ");
      return;
    }
    const currentStops = stopsByRouteRef.current[selectedRouteRef.current] || [];
    if (currentStops.length === 0) return;

    const userLatLng = L.latLng(userLoc[0], userLoc[1]);
    let nearest: Stop | null = null;
    let minDst = Infinity;

    currentStops.forEach((stop) => {
      const stopLatLng = L.latLng(stop.lat, stop.lng);
      const dst = userLatLng.distanceTo(stopLatLng);
      if (dst < minDst) {
        minDst = dst;
        nearest = stop;
      }
    });

    if (nearest && mapRef.current) {
      setTargetStop(nearest);
      targetStopRef.current = nearest;
      calculateETA();
      mapRef.current.flyTo([nearest.lat, nearest.lng], 18, { animate: true });
    }
  };

  /* === Load Initial Data === */
  useEffect(() => {
    async function loadVehicles() {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/admin/vehicles`);
        const vehicles: Vehicle[] = await res.json();
        vehicles.forEach(v => {
          vehicleRouteMapRef.current[String(v.id)] = v.assigned_route_id;
        });
      } catch (err) {
        console.error("Failed to load vehicles", err);
      }
    }
    loadVehicles();
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    function waitForMap() {
      if (mapRef.current && LRef.current) {
        clearInterval(interval);
        mapRef.current.flyTo(RSU_CENTER, 17, { animate: true, duration: 1.2 });
        loadRoutesAndStops();
      }
    }

    async function loadRoutesAndStops() {
      const routeIds = ["R01", "R02"];
      for (const routeId of routeIds) {
        try {
          const stopRes = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/admin/route-stops/${routeId}`);
          const stops: Stop[] = await stopRes.json();
          stopsByRouteRef.current[routeId] = stops;

          const stopLayer = L.layerGroup();
          const stopIcon = L.icon({
            iconUrl: "/icons/stop.png",
            iconSize: [32, 32],
            iconAnchor: [16, 32],
            popupAnchor: [0, -32],
          });

          stops.forEach((stop) => {
            const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon }).addTo(stopLayer);
            marker.on("click", () => {
              setTargetStop(stop);
              targetStopRef.current = stop;
              calculateETA();
            }); 
          });
          stopLayersRef.current[routeId] = stopLayer;

          if (routeId === selectedRouteRef.current && mapRef.current) {
            stopLayersRef.current[routeId]?.addTo(mapRef.current);
          }

          const points = stops.map(p => `${p.lng},${p.lat}`);
          if (points.length > 0) {
            points.push(points[0]);
            const osrmRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${points.join(";")}?overview=full&geometries=geojson`);
            const osrmData = await osrmRes.json();
            if (osrmData.routes?.[0]) {
              const coords: [number, number][] = osrmData.routes[0].geometry.coordinates.map((c: number[]) => [c[1], c[0]]);
              routeGeometryRef.current[routeId] = coords; 

              const routeLayer = L.layerGroup();
              L.polyline(coords, {
                color: routeId === "R01" ? "#FC9186" : "#3B82F6", weight: 5
              }).addTo(routeLayer);
              routeLayersRef.current[routeId] = routeLayer;
              if (routeId === selectedRouteRef.current && mapRef.current) {
                routeLayer.addTo(mapRef.current);
              }
            }
          }
        } catch (err) {
          console.error(`Failed to load route ${routeId}`, err);
        }
      }
    }

    interval = setInterval(waitForMap, 200);
    return () => clearInterval(interval);
  }, []);

  /* === Route Switcher === */
  function handleRouteChange(routeId: string) {
    if (!mapRef.current) return;
    setSelectedRoute(routeId);
    selectedRouteRef.current = routeId;

    Object.values(routeLayersRef.current).forEach(layer => mapRef.current?.removeLayer(layer));
    routeLayersRef.current[routeId]?.addTo(mapRef.current);

    Object.values(stopLayersRef.current).forEach(layer => mapRef.current?.removeLayer(layer));
    stopLayersRef.current[routeId]?.addTo(mapRef.current);

    Object.keys(vehiclesRef.current).forEach(id => {
      const vehicleRoute = vehicleRouteMapRef.current[id];
      const marker = vehiclesRef.current[id];
      if (vehicleRoute === routeId) {
        if (!mapRef.current?.hasLayer(marker)) marker.addTo(mapRef.current!);
      } else {
        if (mapRef.current?.hasLayer(marker)) mapRef.current.removeLayer(marker);
      }
    });

    setTargetStop(null);
    targetStopRef.current = null;
    updateAvailableCount();
  }

  /* === WebSocket Tracking === */
  useEffect(() => {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "";
    const socket: Socket = io(backendUrl);

    socket.on("location-update", (data: LocationUpdateData) => {
      if (!mapRef.current) return;

      const id = String(data.vehicleId || data.id); 
      const newPos: [number, number] = [Number(data.lat), Number(data.lng)];
      
      if (data.speed !== undefined) vehicleSpeedsRef.current[id] = Number(data.speed);
      else if (data.velocity !== undefined) vehicleSpeedsRef.current[id] = Number(data.velocity);

      let vehicleRoute = vehicleRouteMapRef.current[id];

      if (!vehicleRoute) {
        vehicleRoute = selectedRouteRef.current; 
        vehicleRouteMapRef.current[id] = vehicleRoute;
      }

      if (!vehiclesRef.current[id]) {
        const marker = L.marker(newPos, {
          icon: L.icon({
            iconUrl: "/icons/bus.png",
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          }),
        });
        vehiclesRef.current[id] = marker;
        prevPositionsRef.current[id] = newPos;
        if (vehicleRoute === selectedRouteRef.current) marker.addTo(mapRef.current);
        updateAvailableCount();
        return;
      }

      const marker = vehiclesRef.current[id];
      if (vehicleRoute === selectedRouteRef.current) {
        if (!mapRef.current.hasLayer(marker)) marker.addTo(mapRef.current);
      } else {
        if (mapRef.current.hasLayer(marker)) {
          mapRef.current.removeLayer(marker);
          return;
        }
      }

      const oldPos = prevPositionsRef.current[id];
      if (shouldMove(oldPos, newPos)) {
        animateMove(marker, oldPos, newPos);
        prevPositionsRef.current[id] = newPos;
      }

      updateAvailableCount();
    });

    return () => {
      socket.disconnect();
    };
  }, [updateAvailableCount]);

  return (
    <div className="rsu-app">
      <header className="rsu-hdr">
        <h1>Rangsit University</h1>
        <p>Shuttle Bus Map</p>
      </header>

      <div className="rsu-map-wrap">
        <div id="rsu-map" />

        <div className="route-selector">
          {["R01", "R02"].map(route => (
            <button
              key={route}
              className={`route-btn ${selectedRoute === route ? "active" : ""}`}
              onClick={() => handleRouteChange(route)}
            >
              {route}
            </button>
          ))}
        </div>

        <AvailabilityCard count={availableCount} />

        <StopInfoCard 
          targetStop={targetStop}
          eta={realEta}
          onFindNearest={handleFindNearestStop}
        />
      </div>
      <div className="rsu-bar" />
    </div>
  );
}