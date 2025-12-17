import axios from 'axios';
import { DELIVERY_VEHICLES } from '../models/Order.js';


export const computeDeliveryFee = async ({ 
  restaurantLocation, 
  destinationLocation, 
  deliveryVehicle,
  
}) => {
  // --- Validation ---
  if (!restaurantLocation?.lat || !restaurantLocation?.lng) {
    throw new Error('Restaurant coordinates are required');
  }
  
  if (!destinationLocation?.lat || !destinationLocation?.lng) {
    throw new Error('Destination coordinates are required');
  }

   // --- Rate Configuration ---
  const rateConfig = {
    [DELIVERY_VEHICLES.Car]: {
      base: parseFloat(process.env.CAR_BASE_FARE || '150'),
      perKm: parseFloat(process.env.CAR_PER_KM || '13'),
    },
    [DELIVERY_VEHICLES.Motorcycle]: {
      base: parseFloat(process.env.MOTOR_BASE_FARE || '100'),
      perKm: parseFloat(process.env.MOTOR_PER_KM || '10'),
    },
    [DELIVERY_VEHICLES.Bicycle]: {
      base: parseFloat(process.env.BICYCLE_BASE_FARE || '50'),
      perKm: parseFloat(process.env.BICYCLE_PER_KM || '10'),
    },
  };

  const selectedRate = rateConfig[deliveryVehicle];
  if (!selectedRate) {
    throw new Error(
      `Invalid delivery vehicle: ${deliveryVehicle}. Allowed types: ${Object.keys(rateConfig).join(', ')}`
    );
  }

  // --- Calculate Distance via OSRM ---
  const origins = `${restaurantLocation.lng},${restaurantLocation.lat}`; // OSRM uses lng,lat
  const destinations = `${destinationLocation.lng},${destinationLocation.lat}`;
  const mode = deliveryVehicle === DELIVERY_VEHICLES.Bicycle ? 'bike' : 'driving'; // OSRM modes: driving, bike, foot
  const osrmUrl = `https://router.project-osrm.org/route/v1/${mode}/${origins};${destinations}?overview=false`;

  let osrmResponse;
  try {
    osrmResponse = await axios.get(osrmUrl, { timeout: 5000 });
  } catch (error) {
    throw new Error(`Failed to fetch route from OSRM: ${error.message}`);
  }

  const distanceInMeters = osrmResponse?.data?.routes?.[0]?.distance;
  const durationInSeconds = osrmResponse?.data?.routes?.[0]?.duration;

 
  if (!distanceInMeters || distanceInMeters <= 0) {
    throw new Error('Failed to calculate delivery distance');
  }

  // --- Calculate Fee ---
  const distanceKm = distanceInMeters / 1000;
  const rawFee = selectedRate.base + selectedRate.perKm * distanceKm;
  const deliveryFee = Math.ceil(rawFee);

  return {
    deliveryFee,
    distanceKm: parseFloat(distanceKm.toFixed(2)),
    distanceInMeters,
    durationInSeconds,
    vehicleType: deliveryVehicle,
  };
};