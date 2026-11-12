// Import Mapbox as an ESM module
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
// Import D3 as an ESM module
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Check that Mapbox GL JS is loaded
console.log('Mapbox GL JS Loaded:', mapboxgl);

// --- Step 1.0 & 1.3: Mapbox Access Token Configuration ---
// Priority: 1) token in localStorage, 2) configured personal token below
const configuredToken = 'YOUR_MAPBOX_ACCESS_TOKEN';
const savedToken = localStorage.getItem('mapbox_token');

const effectiveToken = (savedToken && savedToken.startsWith('pk.'))
  ? savedToken
  : (configuredToken.startsWith('pk.') && configuredToken !== 'YOUR_MAPBOX_ACCESS_TOKEN' ? configuredToken : '');

// DOM elements for token setup modal
const tokenModal = document.getElementById('token-modal');
const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('token-input');

function showTokenModal() {
  if (tokenModal) {
    tokenModal.style.display = 'flex';
    if (tokenInput && effectiveToken) {
      tokenInput.value = effectiveToken;
    }
  }
}

if (tokenForm) {
  tokenForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (token.startsWith('pk.')) {
      localStorage.setItem('mapbox_token', token);
      location.reload();
    } else {
      alert('Please enter a valid Mapbox public token starting with "pk."');
    }
  });
}

// Assign Mapbox access token
if (effectiveToken) {
  mapboxgl.accessToken = effectiveToken;
} else {
  // Show setup modal if no token is found yet
  showTokenModal();
}

// Initialize the map (Step 1.3)
const map = new mapboxgl.Map({
  container: 'map', // ID of the div where the map will render
  style: 'mapbox://styles/mapbox/streets-v12', // Map style
  center: [-71.09415, 42.36027], // [longitude, latitude] for Boston / Cambridge
  zoom: 12, // Initial zoom level
  minZoom: 5, // Minimum allowed zoom
  maxZoom: 18, // Maximum allowed zoom
});

// Detect authentication failure or invalid token
map.on('error', (e) => {
  const status = e.error?.status || e.status;
  const msg = (e.error?.message || e.message || '').toLowerCase();
  if (status === 401 || status === 403 || msg.includes('not authorized') || msg.includes('invalid token')) {
    console.warn('Mapbox authentication error detected, prompting for token:', e);
    showTokenModal();
  }
});

// Top-level 1440-minute buckets for high-performance temporal filtering (Step 5.4)
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// Quantize scale mapping [0, 1] traffic flow ratio to discrete [0, 0.5, 1] (Step 6.1)
let stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

/**
 * Helper function to convert station coordinates to pixel coordinates on the map.
 * Defined globally so it can be called anywhere in the script (Step 3.3).
 */
function getCoords(station) {
  const lon = +(station.lon ?? station.Long);
  const lat = +(station.lat ?? station.Lat);
  const point = new mapboxgl.LngLat(lon, lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

/**
 * Helper function to format minutes since midnight into HH:MM AM/PM (Step 5.2).
 */
function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

/**
 * Helper function that returns minutes since midnight for a Date object (Step 5.3).
 */
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Efficiently retrieves trips within a 60-minute window around the selected minute
 * using pre-computed 1440-minute buckets, handling midnight wrap-around (Step 5.4).
 */
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat(); // No filtering, return all trips
  }

  // Normalize both min and max minutes to the valid range [0, 1439]
  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  // Handle time filtering across midnight
  if (minMinute > maxMinute) {
    let beforeMidnight = tripsByMinute.slice(minMinute);
    let afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

/**
 * Calculates station traffic counts (arrivals, departures, totalTraffic)
 * based on the filtered trips for the current time window (Step 4.2, 5.3, 5.4).
 */
function computeStationTraffic(stations, timeFilter = -1) {
  // Retrieve filtered trips efficiently from minute buckets
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (v) => v.length,
    (d) => d.start_station_id,
  );

  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (v) => v.length,
    (d) => d.end_station_id,
  );

  // Update station data with filtered counts
  return stations.map((station) => {
    const id = station.short_name ?? station.Number ?? station.station_id;
    const cloned = { ...station };
    cloned.arrivals = arrivals.get(id) ?? 0;
    cloned.departures = departures.get(id) ?? 0;
    cloned.totalTraffic = cloned.arrivals + cloned.departures;
    return cloned;
  });
}

// Wait for Mapbox to fully load before adding layers and fetching data (Step 2.1)
map.on('load', async () => {
  // Ensure the map canvas sizes accurately to its container
  map.resize();

  // --- Step 2.1 & 2.2: Add Boston Bike Lanes ---
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 5,
      'line-opacity': 0.6,
    },
  });

  // --- Step 2.3: Add Cambridge Bike Lanes ---
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 5,
      'line-opacity': 0.6,
    },
  });

  // --- Step 3.2: Select SVG overlay element inside map container ---
  const svg = d3.select('#map').select('svg');

  // --- Step 3.1: Fetch Bluebikes Stations JSON ---
  let rawStations = [];
  try {
    const jsonurl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
    const jsonData = await d3.json(jsonurl);
    console.log('Loaded JSON Data:', jsonData);
    rawStations = jsonData.data.stations;
    console.log('Stations Array:', rawStations);
  } catch (error) {
    console.error('Error loading JSON:', error);
  }

  // --- Step 4.1 & 5.4: Fetch Bluebikes March 2024 Traffic CSV & populate 1440 buckets ---
  try {
    const trafficUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';
    await d3.csv(trafficUrl, (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      const startedMinutes = minutesSinceMidnight(trip.started_at);
      departuresByMinute[startedMinutes].push(trip);

      const endedMinutes = minutesSinceMidnight(trip.ended_at);
      arrivalsByMinute[endedMinutes].push(trip);

      return trip;
    });
    console.log('Traffic CSV loaded and presorted into 1440 minute buckets');
  } catch (error) {
    console.error('Error loading traffic CSV:', error);
  }

  // --- Step 4.2 & 5.4: Compute initial station traffic (all trips, timeFilter = -1) ---
  let stations = computeStationTraffic(rawStations, -1);

  // --- Step 4.3: Radius scale using d3.scaleSqrt() ---
  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic) || 1])
    .range([0, 25]);

  // --- Step 3.3, 4.3, 4.4 & 6.1: Append SVG Circles for Stations ---
  let circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name ?? d.Number ?? d.station_id)
    .enter()
    .append('circle')
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .attr('stroke', 'white')
    .attr('stroke-width', 1)
    .style('--departure-ratio', (d) =>
      d.totalTraffic === 0 ? 0.5 : stationFlow(d.departures / d.totalTraffic),
    );

  // Step 4.4: Add tooltips (<title>) with exact traffic counts
  circles.each(function (d) {
    d3.select(this)
      .append('title')
      .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
  });

  // Step 3.3: Function to update circle positions when the map moves / zooms
  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d).cx)
      .attr('cy', (d) => getCoords(d).cy);
  }

  // Initial positioning
  updatePositions();

  // Reposition markers on Mapbox interaction events (Step 3.3)
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  // --- Step 5.2, 5.3 & 5.4: Reactive Time Slider Filtering ---
  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  /**
   * Updates the scatterplot markers, radii, flow colors, and tooltips
   * based on the given time filter (Step 5.3, 5.4, 6.1).
   */
  function updateScatterPlot(timeFilter) {
    // Recompute station traffic based on the filtered trips
    const filteredStations = computeStationTraffic(rawStations, timeFilter);

    // Adjust scale range dynamically: larger circles when filtered to enhance visibility
    timeFilter === -1
      ? radiusScale.range([0, 25])
      : radiusScale.range([3, 50]);

    // Update circles data binding and attributes
    circles = circles
      .data(filteredStations, (d) => d.short_name ?? d.Number ?? d.station_id)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        d.totalTraffic === 0 ? 0.5 : stationFlow(d.departures / d.totalTraffic),
      );

    // Update tooltip text
    circles.each(function (d) {
      let title = d3.select(this).select('title');
      if (title.empty()) {
        title = d3.select(this).append('title');
      }
      title.text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
    });

    // Update pixel coordinates
    updatePositions();
  }

  /**
   * Reactively updates the time display and triggers scatterplot update (Step 5.2).
   */
  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  // Bind input listener to slider
  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
});
