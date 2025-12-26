import mongoose from "mongoose";
import Food from "./Food.js";
import Restaurant from "../models/restaurantModel.js";

import transactionSchema from "./Transaction.js"; // Your provided schema
import crypto from "crypto";
// ===================================================================
// CONSTANTS
// ===================================================================
export const ORDER_TYPES = {
  Delivery: "Delivery",
  Takeaway: "Takeaway",
  DineIn: "DineIn",
};

export const ORDER_STATUSES = {
  Pending: "Pending",
  Preparing: "Preparing",
  Cooked: "Cooked",
  Delivering: "Delivering",
  Completed: "Completed",
  Cancelled: "Cancelled",
};

export const DELIVERY_VEHICLES = {
  Car: "Car",
  Motorcycle: "Motor",
  Bicycle: "Bicycle",
};


const MAX_ORDER_ITEMS = 5;

// ===================================================================
// STATUS TRANSITION FLOW
// ===================================================================
export const ORDER_STATUS_FLOW = {
  [ORDER_STATUSES.Pending]: [ORDER_STATUSES.Preparing, ORDER_STATUSES.Cooked, ORDER_STATUSES.Cancelled],
  [ORDER_STATUSES.Preparing]: [ORDER_STATUSES.Cooked, ORDER_STATUSES.Cancelled],
  [ORDER_STATUSES.Cooked]: [ORDER_STATUSES.Delivering, ORDER_STATUSES.Cancelled,ORDER_STATUSES.Completed],
  [ORDER_STATUSES.Delivering]: [ORDER_STATUSES.Completed, ORDER_STATUSES.Cancelled],
  [ORDER_STATUSES.Completed]: [],
  [ORDER_STATUSES.Cancelled]: [],
};

// ===================================================================
// 1. SUB-SCHEMA: GeoLocation (GeoJSON Point)
// ===================================================================
const geoLocationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true,
      validate: {
        validator: (v) =>
          Array.isArray(v) &&
          v.length === 2 &&
          v[0] >= -180 && v[0] <= 180 &&
          v[1] >= -90 && v[1] <= 90,
        message: "Invalid coordinates: [lng, lat] must be within valid bounds",
      },
    },
    address: { type: String, trim: true },
    placeName: { type: String, trim: true },
  },
  { _id: false }
);

// ===================================================================
// 2. ORDER ITEM SUB-SCHEMA
// ===================================================================
const orderItemSchema = new mongoose.Schema(
  {
    foodId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Food",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    quantity: { type: Number, required: true, min: 1, max: 1000 },
    price: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
    foodImage: {
      type: String,
      trim: true,
      validate: { validator: v => !v || /^https?:\/\//.test(v), message: "Invalid image URL" },
    },
  },
  { _id: true }
);


// ===================================================================
// 4. MAIN ORDER SCHEMA
// ===================================================================
const orderSchema = new mongoose.Schema(
  {
    // USER
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userPhone: {
      type: String,
      required: true,
      trim: true,
      match: [/^[+]?[0-9\s\-\.\(\)]+$/, "Invalid phone number"],
    },
    fromSponsore: {
    type: Boolean,
    default: false
  },
  sponsoredPhone:{
    type:String,
    validate: {
      validator: function (value) {
        // If fromSponsore is true, sponsoreId must exist
        if (this.fromSponsore === true) {
          return value != null;
        }
        return true; // otherwise, optional
      },
      message: 'sponsoredPhone is required'
    }
  },

    // RESTAURANT
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
    restaurantName: { type: String, required: true, trim: true, maxlength: 200 },
    restaurantLocation: { type: geoLocationSchema, required: true },

    // ORDER ITEMS
    orderItems: {
      type: [orderItemSchema],
      required: true,
      validate: {
        validator: v => v.length > 0 && v.length <= MAX_ORDER_ITEMS,
        message: `Order must have 1–${MAX_ORDER_ITEMS} items`,
      },
    },

    // PRICING
    foodTotal: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
    deliveryFee: { type: mongoose.Schema.Types.Decimal128, default: 0, min: 0 },
    tip: { type: mongoose.Schema.Types.Decimal128, default: 0, min: 0 },
    totalPrice: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
    serviceFee: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
    vatTotal: { type: mongoose.Schema.Types.Decimal128, required: true, min: 0 },
    // ORDER TYPE & DELIVERY
    typeOfOrder: {
      type: String,
      default: ORDER_TYPES.Delivery,
      required: true,
    },
    destinationLocation: {
      type: geoLocationSchema,
      required: function () { return this.typeOfOrder === ORDER_TYPES.Delivery; },
    },
    distanceKm: { type: Number, default: 0, min: 0 },
    deliveryVehicle: {
      type: String,
      enum: Object.values(DELIVERY_VEHICLES),
      validate: {
        validator: function (v) {
          return this.typeOfOrder === ORDER_TYPES.Delivery ? v != null : v == null;
        },
        message: "Delivery vehicle required for Delivery orders",
      },
    },
    

    // STATUS
    orderStatus: {
      type: String,
      enum: Object.values(ORDER_STATUSES),
      default: ORDER_STATUSES.Pending,
      required: true,
      index: true,
    },
 

    orderCode: { type: String, unique: true, sparse: true, trim: true, uppercase: true },
    userVerificationCode: { type: String, trim: true }, 
    deliveryVerificationCode: { type: String, trim: true },
    deliveryId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Assigned delivery person
    // TRANSACTION (from your model)
    transaction: {
      type: transactionSchema,
    
    },

    description: { type: String, trim: true, maxlength: 1000 },
   
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ===================================================================
// INDEXES
// ===================================================================
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ orderStatus: 1, updatedAt: -1 });

// ===================================================================
// PRE-SAVE HOOKS
// ===================================================================
orderSchema.pre("save", async function (next) {
  if (!this.orderCode) this.orderCode = await generateOrderCode();
    if (this.isModified("orderStatus")) {
      console.log("Chck it venus");
  }
  next();
});

export async function generateOrderCode() {
  // 📅 Generate short year-month tag (e.g. "25A" for Jan 2025)
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2); // "25"
  const monthLetter = String.fromCharCode(65 + now.getMonth()); // A–L for Jan–Dec
  const datePart = `${year}${monthLetter}`;

  // 🔐 Generate secure random hex part (e.g. "8FA1C2")
  const randomPart = crypto.randomBytes(3).toString("hex").toUpperCase();

  // 🧾 Combine parts → final code
  const code = `ORD-${datePart}-${randomPart}`;

  // ✅ Return the code (short, clean, and easy to read)
  return code;
}

orderSchema.statics.validateAndComputeOrder = async function ({
  orderItems,
  typeOfOrder,
  deliveryVehicle,
  destinationLocation,
  tip = 0,
  description,
 calculatedDeliveryFee
}) {
  // --- Basic validation ---
  if (!orderItems?.length) throw new Error("At least one item required");
  if (orderItems.length > MAX_ORDER_ITEMS) throw new Error(`Max ${MAX_ORDER_ITEMS} items allowed`);

  if (!Object.values(ORDER_TYPES).includes(typeOfOrder)) {
    throw new Error(`Invalid order type: ${typeOfOrder}`);
  }

  if (typeOfOrder === ORDER_TYPES.Delivery) {
   
    if (!deliveryVehicle || !Object.values(DELIVERY_VEHICLES).includes(deliveryVehicle)) {
      throw new Error(`Invalid delivery vehicle`);
    }
    if (!destinationLocation?.lat || !destinationLocation?.lng) {
      throw new Error("Destination lat/lng required for delivery");
    }
  }

  const parsedTip = parseFloat(tip) || 0;
  if (parsedTip < 0) throw new Error("Tip cannot be negative");

  // --- Fetch foods & validate restaurant ---
const foodIds = orderItems.map(i => i.foodId);

const foods = await Food.find({ _id: { $in: foodIds } }).lean();

const foodMap = new Map(foods.map(f => [f._id.toString(), f]));

let restaurantId = null;
let foodTotal = 0;
const normalizedItems = [];

for (const item of orderItems) {
  const food = foodMap.get(item.foodId.toString());
  if (!food) throw new Error(`Food not found: ${item.foodId}`);

  // ---- NEW VALIDATION (matches your schema) ----
  if (!food.restaurantId) throw new Error('Food is missing restaurantId');
  // (menuId is still required in the schema, so we keep the check)
  if (!food.menuId) throw new Error('Food is missing menuId');

  const restId = food.restaurantId.toString();

  // First item → set the reference restaurant
  if (!restaurantId) {
    restaurantId = restId;
  } else if (restaurantId !== restId) {
    throw new Error('All items must belong to the same restaurant');
  }
  // ----------------------------------------------

  const price = parseFloat(food.price.toString());
  foodTotal += price * item.quantity;

  normalizedItems.push({
    foodId: food._id,
    name: food.foodName,
    quantity: item.quantity,
    price: mongoose.Types.Decimal128.fromString(price.toFixed(2)),
    restaurantId: restaurantId,
  });
}


  const restaurant = await Restaurant.findById(restaurantId);
  if (!restaurant) throw new Error("Restaurant not found");

let deliveryFee = 0;
let serviceFee = 0;


const vatPercentage = process.env.GOV_VAT ? parseFloat(process.env.GOV_VAT) : 0;

const vatTotal =  parseFloat((foodTotal * vatPercentage).toFixed(2)) ;
// Base price always includes food + tip
let totalPrice = foodTotal + parsedTip + vatTotal;

switch (typeOfOrder) {

  case ORDER_TYPES.Delivery:
    deliveryFee = calculatedDeliveryFee ; 
    totalPrice += deliveryFee;
    break;

  case ORDER_TYPES.DineIn:
    serviceFee = parseFloat(process.env.DINEIN_SERVICE_FEE)  ;
    totalPrice += serviceFee;
    break;

  case ORDER_TYPES.Takeaway:
    serviceFee =  parseFloat(process.env.TAKEAWAY_SERVICE_FEE);
    totalPrice += serviceFee;
    break;
  default:
    // No extra fee
    break;
}

console.log("Service Fee:", serviceFee);
console.log("Delivery Fee:", deliveryFee);
console.log("Total Price:", totalPrice);



  return {
    
    orderItems: normalizedItems,
    foodTotal: mongoose.Types.Decimal128.fromString(foodTotal.toFixed(2)),
    vatTotal: mongoose.Types.Decimal128.fromString(vatTotal.toFixed(2)),
    deliveryFee: mongoose.Types.Decimal128.fromString(deliveryFee.toFixed(2)),
    serviceFee:mongoose.Types.Decimal128.fromString(serviceFee.toFixed(2)),
    tip: mongoose.Types.Decimal128.fromString(parsedTip.toFixed(2)),
    totalPrice: mongoose.Types.Decimal128.fromString(totalPrice.toFixed(2)),
    restaurantId,
    restaurantName: restaurant.name,
    restaurantLocation: {
      type: "Point",
      coordinates: restaurant.location.coordinates, // [lng, lat]  
    },
    destinationLocation: typeOfOrder === ORDER_TYPES.Delivery ? {
      type: "Point",
      coordinates: [destinationLocation.lng, destinationLocation.lat],
     
    } : null,
    
    deliveryVehicle: typeOfOrder === ORDER_TYPES.Delivery ? deliveryVehicle : null,
    typeOfOrder,
    description,  
  };
};


// --- Other statics ---
orderSchema.statics.findByUser = function (userId, { status, limit = 10, skip = 0 } = {}) {
  const q = this.find({ userId }).sort({ createdAt: -1 });
  if (status) q.where("orderStatus").equals(status);
  return q.limit(limit).skip(skip);
};

orderSchema.statics.findActiveOrders = function (restaurantId) {
  return this.find({
    restaurantId,
    orderStatus: { $in: [ORDER_STATUSES.Pending, ORDER_STATUSES.Preparing, ORDER_STATUSES.Cooked, ORDER_STATUSES.Delivering] },
  }).sort({ createdAt: 1 });
};

orderSchema.statics.findNearby = function (coordinates, maxDistanceKm = 5) {
  return this.find({
    "destinationLocation.coordinates": {
      $near: {
        $geometry: { type: "Point", coordinates },
        $maxDistance: maxDistanceKm * 1000,
      },
    },
  });
};



// ===================================================================
// PRE-FIND HOOK (only paid by default)
// ===================================================================
orderSchema.pre(["find", "findOne"], function (next) {
  if (!this.getOptions().bypassPaidFilter) {
    this.where({ "transaction.status": "PAID" });
  }
  next();
});


orderSchema.methods.canTransitionTo = function (status) {
  return ORDER_STATUS_FLOW[this.orderStatus]?.includes(status);
};

orderSchema.methods.getSummary = function () {
  return {
    orderCode: this.orderCode,
    status: this.orderStatus,
    restaurantName: this.restaurantName,
    itemCount: this.orderItems.length,
    total: this.totalPrice.toString(),
    createdAt: this.createdAt,
    isPaid: this.isPaid,
    isCompleted: this.isCompleted,
  };
};

orderSchema.methods.getDetails = function () {
  return {
    id: this._id,
    orderCode: this.orderCode,
    status: this.orderStatus,
    statusHistory: this.statusHistory,
    restaurant: {
      id: this.restaurantId,
      name: this.restaurantName,
      location: this.restaurantLocation,
    },
    items: this.orderItems,
    pricing: {
      foodTotal: this.foodTotal.toString(),
      deliveryFee: this.deliveryFee.toString(),
      tip: this.tip.toString(),
      total: this.totalPrice.toString(),
    },
    delivery: {
      type: this.typeOfOrder,
      vehicle: this.deliveryVehicle,
      distance: this.distanceKm,
      location: this.destinationLocation,
      estimatedAt: this.estimatedDeliveryAt,
    },
    payment: this.transaction?.getSummary?.() || this.transaction,
    rating: this.rating,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

// ===================================================================
// EXPORT
// ===================================================================
export default mongoose.model("Order", orderSchema);