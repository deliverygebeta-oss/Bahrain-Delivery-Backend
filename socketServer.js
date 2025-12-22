// socketServer.js
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User from "./models/userModel.js";
import Order, { DELIVERY_VEHICLES } from "./models/Order.js";

const JWT_SECRET = process.env.JWT_SECRET;
const CLIENT_URL = process.env.CLIENT_URL || "*";

// ================= Global State =================
// deliveryId -> { orderId, userId }
export const activeDeliveryOrders = new Map();
// deliveryId -> Set<socket.id>
const deliverySockets = new Map();
// managerId -> Set<socket.id>
const managerSockets = new Map();
// adminId -> Set<socket.id>
const adminSockets = new Map();

// NEW: userId -> Set<socket.id>
// This is the universal mapping that allows sending to any user regardless of role.
const userSockets = new Map();

let io = null;
let activeOrdersLoaded = false;

// ================= Constants & Helpers =================
const ROLES = {
  CUSTOMER: "Customer",
  DELIVERY: "Delivery_Person",
  MANAGER: "Manager",
  ADMIN: "Admin",
};

const generateVerificationCode = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

const isValidLocation = (loc) => {
  if (!loc?.latitude || !loc?.longitude) return false;
  const lat = parseFloat(loc.latitude);
  const lng = parseFloat(loc.longitude);
  return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
};

// ================= Load Active Orders on Startup =================
export const loadActiveDeliveryOrders = async () => {
  if (activeOrdersLoaded) {
    console.log("Active delivery orders already loaded.");
    return;
  }

  try {
    const orders = await Order.find({
      orderStatus: { $in: ["Cooked", "Delivering"] },
      deliveryId: { $exists: true, $ne: null },
    })
      .populate("userId", "_id")
      .select("_id deliveryId userId");

    activeDeliveryOrders.clear();
    orders.forEach((order) => {
      const deliveryId = order.deliveryId.toString();
      activeDeliveryOrders.set(deliveryId, {
        orderId: order._id.toString(),
        userId: order.userId._id.toString(),
      });
    });

    console.log(`Loaded ${orders.length} active delivery orders.`);
    activeOrdersLoaded = true;

    // Ask connected delivery sockets to send a location update (server restart recovery)
    orders.forEach((order) => {
      const sockets = deliverySockets.get(order.deliveryId.toString());
      if (sockets) {
        sockets.forEach((sid) => io.to(sid).emit("requestLocationUpdate", { reason: "serverRestart" }));
      }
    });
  } catch (err) {
    console.error("Failed to load active delivery orders:", err);
  }
};

// ================= Universal user send helper =================
/**
 * Send an event to every connected socket of a user (by userId).
 * Returns true if at least one socket was targeted, false otherwise.
 */
const sendToUser = (userId, event, payload) => {
  try {
    const set = userSockets.get(userId.toString());
    if (!set || set.size === 0) {
      console.log(`sendToUser: user ${userId} has no connected sockets`);
      return false;
    }
    set.forEach((sid) => {
      io.to(sid).emit(event, payload);
    });
    return true;
  } catch (err) {
    console.error("sendToUser error:", err);
    return false;
  }
};

// ================= Notification Helpers (updated to use sendToUser) =================
const notifyRestaurantManager = (managerId, orderData) => {
  try {
    const sockets = managerSockets.get(managerId.toString());
    if (sockets?.size) {
      sockets.forEach((sid) => io.to(sid).emit("newOrder", orderData));
      console.log(`Notified manager ${managerId} on ${sockets.size} device(s)`);
    } else {
      console.log(`notifyRestaurantManager: Manager ${managerId} offline`);
    }
  } catch (err) {
    console.error("Error notifying manager:", err);
  }
};

const notifyDeliveryGroup = (deliveryMethod, message) => {
  try {
    if (!Object.values(DELIVERY_VEHICLES).includes(deliveryMethod)) return;
 loadActiveDeliveryOrders().catch(console.error);
    const namespace = io.of("/");
    const room = namespace.adapter.rooms.get(deliveryMethod);

    if (!room) return console.log(`No delivery persons online for ${deliveryMethod}`);

    room.forEach((socketId) => {
      const socket = namespace.sockets.get(socketId);
      if (!socket || !socket.user?._id) return;

      const deliveryId = socket.user._id.toString();
  

      // 🚫 Skip: this driver already has an active order
      if (activeDeliveryOrders.has(deliveryId)) {
        console.log(
          `⛔ Skipped driver ${deliveryId} — already delivering order ${activeDeliveryOrders.get(deliveryId).orderId}`
        );
        return;
      }

      // ✅ Send only to available / free drivers
      io.to(socketId).emit("deliveryMessage", message);
    });
  } catch (err) {
    console.error("Error notifying delivery group:", err);
  }
};


const notifyCustomer = (customerId, message) => {
  try {
    // Use sendToUser (direct send), fallback to room emit for backward compatibility
    const ok = sendToUser(customerId, "customerMessage", message);
    if (!ok) {
      // fallback (if you previously used rooms)
      io.to(`customer:${customerId}`).emit("customerMessage", message);
    }
  } catch (err) {
    console.error("Error notifying customer:", err);
  }
};

// Export selected helpers if other modules need them
export { notifyRestaurantManager, notifyDeliveryGroup, notifyCustomer, sendToUser };

// ================= JWT Authentication Middleware =================
const authenticateSocket = async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Authentication token required"));

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    const user = await User.findById(decoded.id).select("-password -__v");
    if (!user) return next(new Error("User not found"));

    socket.user = user;
    next();
  } catch (err) {
    next(new Error("Invalid or expired token"));
  }
};

// ================= Socket Initialization =================
export const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: { origin: CLIENT_URL, methods: ["GET", "POST"] },
  });

  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    try {
      const { _id: userId, role, deliveryMethod } = socket.user;
      const userIdStr = userId.toString();

      console.log(`User connected: ${socket.id} | Role: ${role} | ID: ${userIdStr}`);

      // Add to universal userSockets map
      if (!userSockets.has(userIdStr)) userSockets.set(userIdStr, new Set());
      userSockets.get(userIdStr).add(socket.id);
      console.log(`userSockets[${userIdStr}] size=${userSockets.get(userIdStr).size}`);

      // Validate role
      if (!Object.values(ROLES).includes(role)) {
        socket.emit("errorMessage", "Invalid user role");
        // cleanup this connection from userSockets
        const tempSet = userSockets.get(userIdStr);
        if (tempSet) {
          tempSet.delete(socket.id);
          if (tempSet.size === 0) userSockets.delete(userIdStr);
        }
        return socket.disconnect(true);
      }

      // ================= Role: Customer =================
      if (role === ROLES.CUSTOMER) {
        // optional: keep room join for backwards compat - you may remove this if you fully migrated
        // socket.join(`customer:${userIdStr}`);
        socket.emit("message", "Welcome Customer!");
        loadActiveDeliveryOrders().catch(console.error);
      }

      // ================= Role: Delivery Person =================
      if (role === ROLES.DELIVERY) {
        if (!Object.values(DELIVERY_VEHICLES).includes(deliveryMethod)) {
          socket.emit("errorMessage", "Invalid delivery vehicle");
          // cleanup userSockets
          const tempSet = userSockets.get(userIdStr);
          if (tempSet) {
            tempSet.delete(socket.id);
            if (tempSet.size === 0) userSockets.delete(userIdStr);
          }
          return socket.disconnect(true);
        }

        // keep delivery group join for broadcast by vehicle
        socket.join(deliveryMethod);

        if (!deliverySockets.has(userIdStr)) deliverySockets.set(userIdStr, new Set());
        deliverySockets.get(userIdStr).add(socket.id);

        // Restore active order if exists
        if (activeDeliveryOrders.has(userIdStr)) {
          socket.activeOrder = activeDeliveryOrders.get(userIdStr);
        }

        // locationUpdateForAdmin (unchanged)
        socket.on("locationUpdateForAdmin", async (data) => {
          try {
            if (!data || !data.location) {
              return socket.emit("errorMessage", "Location data is required");
            }
            const { location } = data;
            if (!isValidLocation(location)) {
              return socket.emit("errorMessage", "Invalid location data");
            }
            if (location.requestType === "adminRequest" && location.requestedBy) {
              const adminSocketsSet = adminSockets.get(location.requestedBy.toString());
              if (adminSocketsSet?.size) {
                adminSocketsSet.forEach((sid) =>
                  io.to(sid).emit("deliveryLocationUpdate", { location })
                );
              }
            }
          } catch (err) {
            console.error("Error in locationUpdateForAdmin:", err);
            socket.emit("errorMessage", "Failed to update location");
          }
        });

        // ================= locationUpdateFromCustomerTracking =================
        socket.on("locationUpdateFromCustomerTracking", async (data) => {
          try {
            console.log("📡 Received locationUpdateFromCustomerTracking:", data);

            if (!data || !data.location) {
              return socket.emit("errorMessage", "Location data is required");
            }

            const location = data.location;

            if (!isValidLocation(location)) {
              return socket.emit("errorMessage", "Invalid location data");
            }

            if (!location.customerId || !location.orderId) {
              return socket.emit("errorMessage", "Customer ID and Order ID are required");
            }

            const customerId = location.customerId.toString();
            const orderId = location.orderId.toString();

            // Verify this delivery person has this order
            const assignedOrder = activeDeliveryOrders.get(userIdStr);
            if (!assignedOrder) {
              console.log("❌ Delivery person has NO assigned orders");
              return socket.emit("errorMessage", "No active order assigned");
            }

            if (assignedOrder.orderId !== orderId) {
              console.log("❌ Order mismatch", { assignedOrder, orderId });
              return socket.emit("errorMessage", "You are not assigned to this order");
            }

            if (assignedOrder.userId !== customerId) {
              console.log("❌ Customer mismatch", { assignedOrder, customerId });
              return socket.emit("errorMessage", "Customer mismatch for this delivery");
            }

            // Send directly to customer using userSockets (no rooms required)
            const payload = {
              location: {
                latitude: location.latitude,
                longitude: location.longitude,
                accuracy: location.accuracy,
                timestamp: location.timestamp,
                deliveryPersonId: userIdStr,
                deliveryPersonName: location.deliveryPersonName,
                orderId: orderId,
              },
            };

            console.log(`📤 Sending location to user ${customerId}`, payload);

            const delivered = sendToUser(customerId, "deliveryLocationUpdate", payload);

            if (!delivered) {
              // customer offline — optionally fall back to emitting to customer room (for backward compat)
              console.log(`Customer ${customerId} offline; falling back to room emit`);
              io.to(`customer:${customerId}`).emit("deliveryLocationUpdate", payload);
            } else {
              console.log("✅ Location forwarded successfully to customer sockets");
            }
          } catch (err) {
            console.error("🔥 Error in locationUpdateFromCustomerTracking:", err);
            socket.emit("errorMessage", "Failed to update location");
          }
        });

        // ================= acceptOrder (unchanged logic, but notifyCustomer uses sendToUser) =================
        socket.on("acceptOrder", async (data, callback = () => {}) => {
          const session = await mongoose.startSession();
          session.startTransaction();
          try {
            if (!data || !data.orderId) {
              throw new Error("Order ID is required");
            }

            const { orderId } = data;
            const deliveryPersonId = userId;

            // Check for existing active order
            const existingOrder = await Order.findOne({
              deliveryId: deliveryPersonId,
              orderStatus: { $nin: ["Completed", "Cancelled"] },
            }).session(session);

            if (existingOrder) {
              throw new Error("You already have an active order");
            }

            const order = await Order.findById(orderId).populate("userId", "_id").session(session);

            if (!order) throw new Error("Order not found");
            if (order.deliveryId) throw new Error("Order already accepted by another driver");
            if (order.orderStatus !== "Cooked") throw new Error("Order not ready for delivery");
            if (order.typeOfOrder !== "Delivery") throw new Error("Not a delivery order");
            if (order.deliveryVehicle !== deliveryMethod) throw new Error("Vehicle type mismatch");

            const pickUpCode = generateVerificationCode();
            order.deliveryVerificationCode = pickUpCode;
            order.deliveryId = deliveryPersonId;

            await order.save({ session, validateBeforeSave: false});
            await session.commitTransaction();

            console.log(`Order ${order._id} accepted by delivery person ${deliveryPersonId}`);

            // Notify customer (direct)
            notifyCustomer(order.userId._id.toString(), {
              type: "orderAccepted",
              orderId: order._id.toString(),
              deliveryPersonId: deliveryPersonId.toString(),
              message: `Your order ${order.orderCode} has been picked up for delivery!`,
            });

            // Update in-memory state
            activeDeliveryOrders.set(userIdStr, {
              orderId: order._id.toString(),
              userId: order.userId._id.toString(),
            });
            socket.activeOrder = activeDeliveryOrders.get(userIdStr);

            socket.emit("requestLocationUpdate", { reason: "orderAccepted" });

            callback({
              status: "success",
              message: "Order accepted successfully",
              data: {
                orderId: order._id.toString(),
                restaurantLocation: order.restaurantLocation,
                deliverLocation: order.destinationLocation,
                deliveryFee: order.deliveryFee || 0,
                tip: order.tip || 0,
                distanceKm: order.distanceKm,
                description: order.description,
                orderCode: order.orderCode,
                pickUpVerification: pickUpCode,
              },
            });
          } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            console.error("Accept order failed:", error.message);
            callback({
              status: "error",
              message: error.message || "Failed to accept order",
            });
          } finally {
            session.endSession();
          }
        });
      } // end ROLE.DELIVERY

      // ================= Role: Manager =================
      if (role === ROLES.MANAGER) {
        if (!managerSockets.has(userIdStr)) managerSockets.set(userIdStr, new Set());
        managerSockets.get(userIdStr).add(socket.id);
        socket.emit("message", "Welcome Manager!");
      }

      // ================= Role: Admin =================
      if (role === ROLES.ADMIN) {
        if (!adminSockets.has(userIdStr)) adminSockets.set(userIdStr, new Set());
        adminSockets.get(userIdStr).add(socket.id);
        socket.emit("message", "Welcome Admin!");
      }

      // ================= Admin: Request All Locations =================
      socket.on("adminRequestAllLocations", () => {
        try {
          if (role !== ROLES.ADMIN) return;

          console.log(`Admin ${userIdStr} requested all delivery locations`);
          deliverySockets.forEach((sockets) => {
            sockets.forEach((sid) => {
              io.to(sid).emit("requestLocationUpdateForAdmin", {
                reason: "adminRequest",
                requestedBy: userIdStr,
              });
            });
          });
        } catch (err) {
          console.error("Error in adminRequestAllLocations:", err);
          socket.emit("errorMessage", "Failed to request locations");
        }
      });

      // ================= Customer: Request Tracking for Their Order =================
      socket.on("customerRequestDeliveryLocation", (data) => {
        try {
          loadActiveDeliveryOrders().catch(console.error);

          if (!data || !data.orderId) {
            console.error("Order ID is required for tracking request");
            return socket.emit("errorMessage", "Order ID is required");
          }

          const orderId = data.orderId.toString();
          let deliveryId = null;

          for (const [delId, info] of activeDeliveryOrders) {
            if (info.orderId === orderId && info.userId === userIdStr) {
              deliveryId = delId;
              break;
            }
          }

          if (!deliveryId) {
            return socket.emit("errorMessage", "No active delivery found for your order");
          }

          const sockets = deliverySockets.get(deliveryId);
          if (!sockets || sockets.size === 0) {
            return socket.emit("errorMessage", "Delivery person is currently offline");
          }

          // Request the delivery person(s) to start periodic tracking for this customer
          sockets.forEach((sid) => {
            io.to(sid).emit("startPeriodicTracking", {
              customerId: userIdStr,
              orderId,
            });
          });

          // notify the customer that tracking started
          socket.emit("trackingStarted", { deliveryId, orderId });
        } catch (err) {
          console.error("Error in customerRequestDeliveryLocation:", err);
          socket.emit("errorMessage", "Failed to start tracking");
        }
      });

      // ================= Customer: Stop Tracking =================
      socket.on("customerRequestStopTracking", (data) => {
        try {
          if (!data || !data.deliveryId) {
            return socket.emit("errorMessage", "Delivery ID is required");
          }

          const sockets = deliverySockets.get(data.deliveryId.toString());
          if (sockets) {
            sockets.forEach((sid) => io.to(sid).emit("stopPeriodicTracking"));
          }
        } catch (err) {
          console.error("Error in customerRequestStopTracking:", err);
          socket.emit("errorMessage", "Failed to stop tracking");
        }
      });

      // ================= Disconnect Handling =================
      socket.on("disconnect", () => {
        try {
          console.log(`User disconnected: ${socket.id} | ${role} | ${userIdStr}`);

          // universal cleanup from userSockets
          const uset = userSockets.get(userIdStr);
          if (uset) {
            uset.delete(socket.id);
            if (uset.size === 0) userSockets.delete(userIdStr);
          }

          // Clean up delivery sockets
          if (role === ROLES.DELIVERY) {
            const set = deliverySockets.get(userIdStr);
            if (set) {
              set.delete(socket.id);
              if (set.size === 0) deliverySockets.delete(userIdStr);
            }
          }

          // Clean up manager/admin sockets
          [managerSockets, adminSockets].forEach((map) => {
            const set = map.get(userIdStr);
            if (set) {
              set.delete(socket.id);
              if (set.size === 0) map.delete(userIdStr);
            }
          });
        } catch (err) {
          console.error("Error during disconnect cleanup:", err);
        }
      });
    } catch (err) {
      console.error("Error in connection handler:", err);
      socket.emit("errorMessage", "Connection error occurred");
      socket.disconnect(true);
    }
  });
};

export default {initializeSocket, loadActiveDeliveryOrders};
