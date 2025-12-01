import mongoose from 'mongoose';
import Order, { 
  ORDER_TYPES, 
  DELIVERY_VEHICLES, 
  ORDER_STATUSES,
} from "../models/Order.js";
import { TRANSACTION_STATUSES } from "../models/Transaction.js";
import Restaurant from '../models/restaurantModel.js';
import User from '../models/userModel.js';
import axios from 'axios';
import { getIO } from '../utils/socket.js';
import { computeDeliveryFee } from '../utils/computeDeliveryFee.js';
import Balance, { REQUESTER_TYPES, TRANSACTION_TYPES } from "../models/Balance.js";
import { ref, remove } from 'firebase/database';
import { database,  set } from "../firebase.js";
import { notifyCustomer ,notifyRestaurantManager,notifyDeliveryGroup} from '../socketServer.js';
import AfroMessageService from '../utils/AfroMessageService.js';
import { activeDeliveryOrders } from '../socketServer.js';
// Initialize AfroMessage service
const afroMessageService = new AfroMessageService();

export const initializeChapaPayment = async ({ amount, currency, orderId, user }) => {
  try {
    const numericAmount = Number(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      throw new Error("Invalid amount provided to Chapa");
    }
    // Generate unique transaction reference
    const txRef = `CHAPA-${orderId}-${Date.now()}`;
    
    const callbackUrl = `${process.env.SERVER_URL}/api/v1/orders/chapa-webhook`;

    // Initialize payment request
    const chapaResponse = await axios.post(
      "https://api.chapa.co/v1/transaction/initialize",
      {
        amount:1,
        currency,
        first_name: user.firstName|| "Customer",
      
        phone_number: user.phone,
        tx_ref: txRef,
        callback_url: callbackUrl,
        customization: {
          title: "Gebeta Pay", // ✅ only 10 chars
          description: `Order ${txRef}`, // ✅ ~20–30 chars max
        },
        meta: {
          hide_receipt: true,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    // ✅ Return the Chapa checkout URL and tx_ref
    return {
      checkout_url: chapaResponse.data.data.checkout_url,
      tx_ref: txRef,
    };
  } catch (error) {
    console.error("❌ Error initializing Chapa payment:", error.response?.data || error.message);
    throw new Error("Failed to initialize Chapa payment");
  }
};
// Generate a 6-digit verification code
export const generateVerificationCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};
export const placeOrder = async (req, res, next) => {
  try {
    const {
      fromSponsore,
      sponsoredPhone,
      orderItems,
      typeOfOrder,
      vehicleType,
      destinationLocation,
      tip,
      description,
      callculatedDeliveryFee,
    } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

   
    let userPhone = user.phone;
    let isFromSponsore = false;
    // Handle sponsorship logic
    if (fromSponsore===true) {
      if (!sponsoredPhone) {
        return res.status(400).json({
          message: 'sponsoredPhone is required when fromSponsore is true',
        });
      }
      isFromSponsore = true;
    }

    // Validate and compute order
    const computeorder = await Order.validateAndComputeOrder({
      orderItems,
      typeOfOrder,
      deliveryVehicle: vehicleType,
      destinationLocation,
      tip,
      description,
      calculatedDeliveryFee: Number(callculatedDeliveryFee.toFixed(2)), // fixed typo & precision
    });

    // Create order in DB
    const order = await Order.create({
      userId:user._id,
      userPhone:user.phone,
      fromSponsore: isFromSponsore,     
      sponsoredPhone:sponsoredPhone,
      orderItems: computeorder.orderItems,
      foodTotal: computeorder.foodTotal,
      deliveryFee: computeorder.deliveryFee,
      tip: computeorder.tip,
      totalPrice: computeorder.totalPrice,
      deliveryVehicle: computeorder.deliveryVehicle,
      typeOfOrder: computeorder.typeOfOrder,
      description: computeorder.description,

      restaurantId: computeorder.restaurantId,
      restaurantName: computeorder.restaurantName,
      destinationLocation: computeorder.destinationLocation,
      restaurantLocation: computeorder.restaurantLocation,
      distanceKm: computeorder.distanceKm,
      serviceFee:computeorder.serviceFee,
      transaction: {
        amount: computeorder.totalPrice,
        status: TRANSACTION_STATUSES.PENDING,
        currency: 'ETB',
      },
    });

    // console.log(order);
    // Validate user phone (should already exist, but safe check)
    if (!userPhone) {
      return res.status(400).json({
        message: 'User phone number is required',
      });
    }

    // Initialize Chapa payment
    const paymentInit = await initializeChapaPayment({
      amount: computeorder.totalPrice,
      currency: 'ETB',
      orderId: order._id,
      user:user // pass correct user for callback
    });

    return res.status(201).json({
      status: 'success',
      data: {
        payment: paymentInit,
        orderId: order._id,
      },
    });
  } catch (error) {
    console.error('Error placing order:', error);
    next(error);
  }
};
export const chapaWebhook = async (req, res) => {
  try {
    // 1️⃣ Chapa sends tx_ref and status as query params or JSON body
    const { trx_ref, status } = req.query;
   
    if (status !== "success") {
      return res.status(400).json({ message: "Payment not successful" });
    }

    // 2️⃣ Verify with Chapa API
    const chapaSecretKey = process.env.CHAPA_SECRET_KEY;
    const verifyUrl = `https://api.chapa.co/v1/transaction/verify/${trx_ref}`;
    const verifyRes = await axios.get(verifyUrl, {
      headers: { Authorization: `Bearer ${chapaSecretKey}` },
    });

    const verifyData = verifyRes.data;
    
    if (verifyData.status !== "success" || verifyData.data.status !== "success") {
      return res.status(400).json({ message: "Chapa verification failed" });
    }

    
    // 3️⃣ Extract middle orderId from "CHAPA-<orderId>-<timestamp>"
    const parts = trx_ref.split("-");
    const orderId = parts[1];
    if (!orderId) {
      return res.status(400).json({ message: "Invalid trx_ref format" });
    }
   
    // 4️⃣ Find the order (bypass paid filter)
    const order = await Order.findById(orderId, null, { bypassPaidFilter: true });
    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }
    const userVerification=generateVerificationCode();

    
    // 5️⃣ Update transaction details safely
    order.transaction.status = "PAID";
    order.transaction.amount = order.totalPrice;
    order.userVerificationCode=userVerification;
    order.transaction.chapaPayment = {
      txRef: trx_ref,
      chapaRefId: verifyData.data?.reference ,
      chapaAmount: verifyData.data.amount,
      charpaCurrency: verifyData.data.currency,
      chapaMethod: verifyData.data?.method || "Unknown",
      chapaType: verifyData.data?.type || "API",
      chapaVerifiedAt: new Date(),
      chapaResponse: verifyData.data,
    };

    await order.save();
   // 6️⃣ Send SMS to customer with order details
   try {
    const userMessage = ` Order Confirmed!
  Order Code: ${order.orderCode}
  Verification Code: ${userVerification}
  
  Please show this verification code to the delivery personnel upon arrival.
  Thank you for choosing our service!`;
  
    const sponsorMessage = `You have been gifted!
  From: ${order.userPhone}
  Order Code: ${order.orderCode}
  Verification Code: ${userVerification}
  
  Please provide this code to the delivery personnel upon receiving the order.
  Thank you for partnering with us!`;
  
  

const recipientPhone = order.fromSponsore ? order.sponsoredPhone : order.userPhone;
const message = order.fromSponsore ? sponsorMessage : userMessage;
const smsResult = await afroMessageService.sendMessage(recipientPhone, message);
    if (smsResult.success) {
      console.log(`📱 SMS successfully sent to ${order.userPhone} for order ${order.orderCode}`);
    } else {
      console.error(`⚠️ SMS sending failed: ${smsResult.error}`);
      // Continue without interrupting order processing
    }
  } catch (smsError) {
    console.error('⚠️ SMS sending error:', smsError.message);
    // Continue even if SMS fails
  }
    // 6️⃣ Notify restaurant manager
    const restaurant = await Restaurant.findById(order.restaurantId);
    if (restaurant?.managerId) {
      await notifyRestaurantManager(restaurant.managerId, {
        orderId: order._id,
        totalPrice: order.foodTotal,
        orderCode: order.orderCode,
        typeOfOrder: order.typeOfOrder,
        createdAt: order.createdAt,
      });
      console.log(`📢 Notified manager ${restaurant.managerId} about payment`);
    } else {
      console.log(`⚠️ Restaurant ${order.restaurantId} has no manager assigned`);
    }

    // 7️⃣ Respond to Chapa webhook
    return res.status(200).json({ message: "Webhook processed successfully" });
  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ message: "Server error processing webhook" });
  }
};
export const updateOrderStatus = async (req, res, next) => {
  try {
    const { orderId, status } = req.body;
    if (!orderId || !status) {
      return res.status(400).json({
        error: { message: "Both orderId and status are required." },
      });
    }
   
    if (!Object.values(ORDER_STATUSES).includes(status)) {
      return res.status(400).json({
        error: { message: `Invalid order status: ${status}` },
      });
    }
    const existingOrder = await Order.findById(orderId);
    if (!existingOrder) {
      return res.status(404).json({ error: { message: "Order not found." } });
    }
    if (!existingOrder.canTransitionTo(status)) {
      return res.status(400).json({
        error: {
          message: `Invalid status transition from ${existingOrder.orderStatus} → ${status}`,
        },
      });
    }
    const updatedOrder = await Order.findOneAndUpdate(
      { _id: orderId },
      { $set: { orderStatus: status } },
      { new: true, runValidators: true } // return updated doc
    );

    // --- 5️⃣ Notify delivery group when cooked ---
    if (
      status === ORDER_STATUSES.Cooked &&
      updatedOrder.typeOfOrder === ORDER_TYPES.Delivery
    ) {
      const deliveryGroup = updatedOrder.deliveryVehicle; // "CAR", "MOTORCYCLE", etc.
      

      notifyDeliveryGroup(deliveryGroup, {
        orderId: updatedOrder._id,
        orderCode: updatedOrder.orderCode,
        restaurantLocation: updatedOrder.restaurantLocation,
        restaurantName: updatedOrder.restaurantName,
        deliveryLocation: updatedOrder.destinationLocation,
        deliveryFee: updatedOrder.deliveryFee,
        tip: updatedOrder.tip,
        createdAt: updatedOrder.createdAt,
      });
    }

    // --- 6️⃣ Respond success ---
    return res.status(200).json({
      status: "success",
      message: `Order status successfully updated to "${status}".`,
      data: { order: updatedOrder },
    });
  } catch (error) {
    console.error("❌ Error updating order status:", error);
    next(error);
  }
}
export const acceptOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { orderId } = req.body;
    const deliveryPersonId = req.user._id;

    if (!orderId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: "Order ID is required." });
    }

    // ✅ Check for existing active order
    const existingOrder = await Order.findOne({
      deliveryId: deliveryPersonId,
      orderStatus: { $nin: [ORDER_STATUSES.Completed, ORDER_STATUSES.Cancelled] },
    }).session(session);

    if (existingOrder) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        error:
          "You already have an active order. Complete or cancel it before accepting a new one.",
        activeOrder: {
          orderId: existingOrder._id,
          status: existingOrder.orderStatus,
        },
      });
    }

    // ✅ Find the order and validate
    const order = await Order.findById(orderId)
      .populate("userId", "_id")
      .session(session);

    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.orderStatus !== ORDER_STATUSES.Cooked) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: "Order is not ready for delivery." });
    }

    if (order.typeOfOrder !== ORDER_TYPES.Delivery) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ error: "Only delivery orders can be accepted." });
    }

    if (req.user.deliveryMethod !== order.deliveryVehicle) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        error: "You are not eligible to accept this order type.",
      });
    }

    // ✅ Assign delivery and generate verification code
    const pickUpCode = generateVerificationCode();
    order.deliveryVerificationCode = pickUpCode;
    order.deliveryId = deliveryPersonId;
  
    await order.save({ session });

    await session.commitTransaction();
    session.endSession(); // ✅ End session after commit

     try {
      await set(ref(database, `deliveryOrders/${order._id.toString()}`), {
        orderId: order._id.toString(),
        userId: order.userId.toString(),
        deliveryPersonId: deliveryPersonId.toString(),
        orderStatus: order.orderStatus,
        restaurantLocation: {
          type: order.restaurantLocation.type,
          coordinates: order.restaurantLocation.coordinates,
          
        },
        destinationLocation: {
          type: order.destinationLocation.type,
          coordinates: order.destinationLocation.coordinates,
         
        },
        deliveryVehicle: order.deliveryVehicle,
        pickUpVerification: pickUpCode,
        createdAt: new Date().toISOString(),
      });
    } catch (firebaseError) {
      console.error("⚠️ Failed to sync to Firebase:", firebaseError);
      // Don't fail the request, just log
    }

    // ✅ Respond to client
    res.status(200).json({
      status: "success",
      message: `Order ${order.orderCode} accepted.`,
      data: {
        restaurantLocation: order.restaurantLocation,
        deliverLocation: order.destinationLocation,
        deliveryFee: parseFloat(order.deliveryFee?.toString() || "0"),
        tip: parseFloat(order.tip?.toString() || "0"),
        distanceKm: order.distanceKm,
        description: order.description,
        status: order.orderStatus,
        orderCode: order.orderCode,
        pickUpVerification: pickUpCode,
      },
    });
  } catch (error) {
    // ✅ Only abort if transaction is still active
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error("❌ Error accepting order:", error);
    res.status(500).json({
      status: "error",
      message: error.message || "An error occurred while accepting the order.",
    });
  }
};
export const pickUpOrder = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, pickupVerificationCode } = req.body;

    // Step 1: Validate input
    if (!orderId?.trim() || !pickupVerificationCode?.trim()) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "fail",
        message: "Order ID and pickup verification code are required.",
      });
    }

    if (!mongoose.isValidObjectId(orderId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "fail",
        message: "Invalid order ID format.",
      });
    }

    // Step 2: Find order (lock for update)
    const order = await Order.findOne({
      _id: orderId,
      orderStatus: ORDER_STATUSES.Cooked,
    }).session(session);

    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        status: "fail",
        message: "No cooked order found with the given ID.",
      });
    }
    // Step 3: Verify the pickup code
    let isVerified = false;

    if (order.typeOfOrder === ORDER_TYPES.Delivery) {
      if (order.deliveryVerificationCode === pickupVerificationCode) {
        isVerified = true;
        order.orderStatus = ORDER_STATUSES.Delivering;
      }
    } 
    
    else if (
      order.typeOfOrder === ORDER_TYPES.Takeaway ||
      order.typeOfOrder === ORDER_TYPES.DineIn
    ) 
    {
      if (order.userVerificationCode === pickupVerificationCode) {
        isVerified = true;
        order.orderStatus = ORDER_STATUSES.Completed;
      }
    }

    // Step 4: If verification fails, abort
    if (!isVerified) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "fail",
        message: "Invalid pickup verification code.",
      });
    }

    // Step 5: Save updated order
    await order.save({ session });

    // ✅ Step 6: Create restaurant balance (only after verification success)
    const newBalance = await Balance.create(
      [
        {
          requesterType: REQUESTER_TYPES.Restaurant,
          restaurantId: order.restaurantId,
          amount: order.foodTotal,
          status:TRANSACTION_STATUSES.PAID,
          type: TRANSACTION_TYPES.Deposit,
          note: `Deposit for order ${order._id}`,
        },
      ],
      { session }
    );

    // Step 7: Recalculate restaurant total balance
    const totalBalance = await Balance.calculateTotal(order.restaurantId);

    // Step 8: Commit transaction
    await session.commitTransaction();
    session.endSession();

    // Step 9: Respond success
    return res.status(200).json({
      status: "success",
      message: `Order ${order._id} verified successfully. Restaurant balance updated.`,
      
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("🚨 Pickup Order Error:", error);
    next({
      statusCode: 500,
      message: "An unexpected error occurred while processing pickup.",
      details: error.message,
    });
  }
};
export const verifyOrderDelivery = async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { order_id, verification_code } = req.body;
    const deliveryPersonId = req.user?._id;

    // 🔹 Validate input
    if (!order_id || !verification_code) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "fail",
        message: "Order ID and verification code are required.",
      });
    }

    if (!deliveryPersonId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(401).json({
        status: "fail",
        message: "Unauthorized: Delivery person ID required.",
      });
    }

    console.log(`🚚 Verifying delivery for order: ${order_id} by ${deliveryPersonId}`);

    // 🔹 Find the order that belongs to this delivery person and is still delivering
    const order = await Order.findOne({
      _id: order_id,
      deliveryId: deliveryPersonId,
      orderStatus: ORDER_STATUSES.Delivering,
    }).session(session);

    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        status: "fail",
        message: "Order not found or not assigned to you.",
      });
    }

    // 🔹 Verify the code
    if (String(order.userVerificationCode) !== String(verification_code)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        status: "fail",
        message: "Invalid verification code.",
      });
    }

    // 🔹 Mark order as completed
    order.orderStatus = ORDER_STATUSES.Completed;
    await order.save({ session });
   const delId = deliveryPersonId.toString();
if (activeDeliveryOrders.has(delId)) {
  activeDeliveryOrders.delete(delId);
  console.log(`🟢 Removed active order for deliveryId ${delId} after completion`);
}
    // 🔹 Record delivery earning (Deposit)
    const deliveryBalance = await Balance.create(
      [
        {
          requesterType: REQUESTER_TYPES.Delivery,
          deliveryId: deliveryPersonId,
          amount: mongoose.Types.Decimal128.fromString(
            (order.deliveryFee || 0).toString()
          ),
          type: TRANSACTION_TYPES.Deposit,
          note: `Delivery payment for order ${order._id}`,
          status:TRANSACTION_STATUSES.PAID,
        },
      ],
      { session }
    );

    // 🔹 Recalculate total balance for this delivery person
    const totalBalance = await Balance.calculateTotal(deliveryPersonId);

    // 🔹 Try to remove the order from Firebase (non-blocking)
    try {
      await remove(ref(database, `deliveryOrders/${order._id.toString()}`));
    } catch (firebaseError) {
      console.warn("⚠️ Firebase removal failed:", firebaseError.message);
    }

    // 🔹 Commit transaction
    await session.commitTransaction();
    session.endSession();

    // 🔹 Send response
    return res.status(200).json({
      status: "success",
      message: "Order delivery verified successfully and balance updated.",
      data: {
        orderId: order._id,
        deliveryPersonId,
        deliveryEarnings: Number(order.deliveryFee || 0),
        currentBalance: Number(totalBalance || 0),
        newBalanceRecord: deliveryBalance[0],
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error("❌ Error verifying order delivery:", error.message);
    next({
      statusCode: 500,
      message: "An unexpected error occurred while verifying order delivery.",
      details: error.message,
    });
  }
};
export const getOrdersByRestaurantId = async (req, res, next) => {
  try {
    const { restaurantId } = req.params;

    if (!restaurantId) {
      return next(new AppError('Restaurant ID is required', 400));
    }

    // 🔹 Query with conditions: Paid transactions + allowed order statuses
    const orders = await Order.find({
      restaurantId: restaurantId,
      
    });

    if (!orders || orders.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No matching orders found for this restaurant',
      });
    }

    const formattedOrders = orders.map(order => {


      return {
        userName: order.userId?.firstName,
        phone: order.fromSponsore ? order.sponsoredPhone : order.userPhone,
        items: order.orderItems.map(item => ({
          foodName: item.name,
          quantity: item.quantity,
          price: Number(item.price),
        })),
        totalFoodPrice: Number(order.foodTotal),
        orderDate: order.createdAt,
        orderType: order.typeOfOrder,
        orderStatus: order.orderStatus,
        orderId: order._id,
        orderCode: order.orderCode,
        description:order.description,
        fromSponsore: order.fromSponsore,
        
      };
    });

    res.status(200).json({
      status: 'success',
      results: formattedOrders.length,
      data: formattedOrders,
    });
  } catch (error) {
    next(error);
  }
};
export const getMyOrders = async (req, res, next) => {
  try {
    const userId = req.user._id;

    const orders = await Order.find({ userId });

     const formattedOrders = orders.map(order => {


      return {
        
        phone: order.userPhone,
        items: order.orderItems.map(item => ({
          foodName: item.name,
          quantity: item.quantity,
          price: Number(item.price),
        })),
        totalFoodPrice: Number(order.foodTotal),
        orderDate: order.createdAt,
        orderType: order.typeOfOrder,
        orderStatus: order.orderStatus,
        orderId: order._id,
        orderCode: order.orderCode,
        description:order.description,
        userVerificationCode:order.userVerificationCode,
      
      };
    });


    res.status(200).json({
      status: 'success',
      results: formattedOrders.length,
      data: formattedOrders,
    });
  } catch (error) {
    console.error("Error getting user orders:", error);
    res.status(500).json({
      status: "error",
      message: "Failed to fetch orders",
    });
    next(error);
  }
};
export const getOrdersByPhone = async (req, res) => {
  try {
    const { phoneNumber } = req.body;

    // ✅ Validate input
    if (!phoneNumber) {
      return res.status(400).json({
        status: 'error',
        message: 'Phone number is required to fetch orders.',
      });
    }

    
    // ✅ Fetch orders directly
    const orders = await Order.find({
      "userPhone":phoneNumber, 
    }).sort({ createdAt: -1 });

    // ✅ Handle no results
    if (!orders.length) {
      return res.status(404).json({
        status: 'error',
        message: 'No active orders found for this phone number.',
      });
    }

    res.status(200).json({
      status: 'success',
      results: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error('❌ Error fetching orders by phone number:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch orders by phone number',
      error: error.message,
    });
  }
};
export const getCookedOrders = async (req, res, next) => {
  try {

    const cookedOrders = await Order.find({ 
      orderStatus: ORDER_STATUSES.Cooked,
    }).sort({ updatedAt: -1 });
    // Map the response to include only desired fields
    const formattedOrders = cookedOrders.map(order => ({
      userPhone: order.userId?.phone,
      orderId: order._id,
      restaurantName: order.restaurantName,
      restaurantLocation: order.restaurantLocation,
     
    
      deliveryFee: order.deliveryFee,
      tip: order.tip,
      totalPrice: order.totalPrice,
      DeliveryMethod:order.deliveryVehicle,
    }));

    res.status(200).json({
      status: 'success',
      results: formattedOrders.length,
      data: formattedOrders
    });
  } catch (error) {
    console.error('Error fetching cooked orders:', error.message);
    res.status(500).json({ message: 'Server error retrieving cooked orders' });
  }
};
export const getAvailableCookedOrders = async (req, res, next) => {
  try {
     const vehicleType = req.user.deliveryMethod;
    const availableOrders = await Order.find({
      orderStatus: ORDER_STATUSES.Cooked,
      typeOfOrder: ORDER_TYPES.Delivery,
      deliveryId: { $exists: false }, // No delivery assigned yet
      deliveryVehicle:vehicleType
    })
      .populate("restaurantId", "name")
      .sort({ createdAt: 1 }); // FIFO (oldest first)

    const formattedOrders = availableOrders.map((order) => ({
      orderId: order._id,
      orderCode: order.orderCode,
      restaurantName: order.restaurantId?.name || "",
      restaurantLocation: order.restaurantLocation || null,
      deliveryLocation: order.destinationLocation || null,
      phone: order.fromSponsore ? order.sponsoredPhone : order.userPhone,
      deliveryFee: parseFloat(order.deliveryFee?.toString() || "0"),
      tip: parseFloat(order.tip?.toString() || "0"),
      grandTotal: parseFloat(order.totalPrice?.toString() || "0"),
      createdAt: order.createdAt,
      fromSponsore: order.fromSponsore,
    }));

    res.status(200).json({
      status: "success",
      results: formattedOrders.length,
      data: formattedOrders,
    });
  } catch (error) {
    console.error("Error fetching available cooked orders:", error.message);
    res.status(500).json({
      status: "error",
      message: "Server error retrieving available cooked orders",
    });
  }
};
export const getAvailableCookedOrdersCount = async (req, res, next) => {
  try {
    const count = await Order.countDocuments({ 
      orderStatus: ORDER_STATUSES.Cooked, 
      typeOfOrder: ORDER_TYPES.Delivery,
      deliveryId: { $exists: false }
    });

    res.status(200).json({
      status: 'success',
      data: { count }
    });
  } catch (error) {
    console.error('Error counting available cooked orders:', error.message);
    res.status(500).json({ message: 'Server error counting available cooked orders' });
  }
};
export const estimateDeliveryFee = async (req, res) => {
  try {
    const { restaurantId, destination } = req.body;
    if (!restaurantId) {
      return res.status(400).json({ message: 'restaurantId is required.' });
    }
    const restaurant = await Restaurant.findById(restaurantId);
    if (!restaurant?.location?.coordinates) {
      return res.status(404).json({ message: 'Restaurant location not found.' });
    }
    const restaurantLocation = {
      lng: restaurant.location.coordinates[0], // [0] = longitude
      lat: restaurant.location.coordinates[1], // [1] = latitude
    };

    const carResult = await computeDeliveryFee(
      { restaurantLocation, destinationLocation: destination,deliveryVehicle: DELIVERY_VEHICLES.Car },
     
    );
    const motorResult = await computeDeliveryFee(
      { restaurantLocation, destinationLocation: destination, deliveryVehicle: DELIVERY_VEHICLES.Motorcycle },
      
    );
    const bicycleResult = await computeDeliveryFee(
      { restaurantLocation, destinationLocation: destination,deliveryVehicle: DELIVERY_VEHICLES.Bicycle },
      
    );

    return res.status(200).json({
      status: 'success',
      data: {
        [DELIVERY_VEHICLES.Car]: carResult,
        [DELIVERY_VEHICLES.Motorcycle]: motorResult,
        [DELIVERY_VEHICLES.Bicycle]: bicycleResult,
      },
    });
  } catch (err) {
    return res.status(400).json({ status: 'fail', message: err.message });
  }
};

export const getServiceFee = async (req, res) => {
  try {
    const dineInSeviceFee = parseFloat(process.env.DINEIN_SERVICE_FEE);
    const takeawayServiceFee = parseFloat(process.env.TAKEAWAY_SERVICE_FEE);
    
    return res.status(200).json({
      status: "success",
      data: {
        dineInSeviceFee,
        takeawayServiceFee
      },
    });
  } catch (err) {
    return res.status(400).json({
      status: "fail",
      message: err.message,
    });
  }
};
export const getOrdersByDeliveryMan = async (req, res, next) => {
  try {
    const deliveryPersonId = req.user._id; // from auth middleware
    const { status } = req.query; // e.g. ?status=Cooked or ?status=Delivering

    console.log("Fetching orders for delivery person:", deliveryPersonId, "with status:", status);

    // ✅ Build query
    const query = { deliveryId: deliveryPersonId };

    // ✅ Optional status filter
    if (status && [ORDER_STATUSES.Cooked, ORDER_STATUSES.Delivering, ORDER_STATUSES.Completed].includes(status)) {
      query.orderStatus = status;
    }

    // ✅ Fetch multiple orders
    const orders = await Order.find(query)
      .populate("userId", "firstName phone")
      .populate("restaurantId", "name location")
      .sort({ updatedAt: -1 });

    // if (!orders || orders.length === 0) {
    //   return res.status(404).json({
    //     status: "fail",
    //     message: "No orders found for this delivery person",
    //   });
    // }

    // ✅ Transform response
    const formattedOrders = orders.map((order) => ({

      id: order._id,
      restaurantLocation: order.restaurantLocation,
      destinationLocation: order.destinationLocation,
      userName: order.userId?.firstName,
      phone: order.fromSponsore ? order.sponsoredPhone : order.userId?.phone,
      restaurantName: order.restaurantId?.name,
      deliveryFee: parseFloat(order.deliveryFee?.toString() || "0"),
      tip: parseFloat(order.tip?.toString() || "0"),
      description: order.description,
      orderStatus: order.orderStatus,
      orderCode: order.orderCode,
      pickUpVerificationCode: order.deliveryVerificationCode,
      updatedAt: order.updatedAt,
      fromSponsore: order.fromSponsore,
    }));

    res.status(200).json({
      status: "success",
      count: formattedOrders.length,
      data: formattedOrders,
    });
  } catch (error) {
    console.error("Error fetching delivery man orders:", error.message);
    res.status(500).json({ message: "Server error retrieving delivery orders" });
  }
};
export const getDeliveryOrderHistory = async (req, res, next) => {
  try {
    const deliveryPersonId = req.user._id;

    const orders = await Order.find({
      deliveryId: deliveryPersonId,
      orderStatus: ORDER_STATUSES.Completed
    })
    .populate('restaurantId', 'name')
    .sort({ updatedAt: -1 });

    if (orders.length === 0) {
      return res.status(404).json({
        status: 'fail',
        message: 'No completed orders found for this delivery person',
      });
    }

    // Map orders to extract relevant data for history
    const orderHistory = orders.map(order => ({
      orderId: order._id,
      restaurantName: order.restaurantId?.name || 'Unknown',
      deliveryFee: parseFloat(order.deliveryFee?.toString() || '0'),
      tip: parseFloat(order.tip?.toString() || '0'),
      completedAt: order.updatedAt
    }));

    res.status(200).json({
      status: 'success',
      results: orders.length,
      data: {
        orders: orderHistory
      },
    });
  } catch (error) {
    console.error(`Error fetching delivery order history for delivery person ${req.user._id}:`, error.message);
    next(error);
  }
};
export const getOrdersByStatus = async (req, res) => {
  try {
    const { status } = req.params;

    // Allowed statuses from schema
    const allowedStatuses = Object.values(ORDER_STATUSES);

    let filter = {};

    if (status && status !== "all") {
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: `Invalid status: ${status}` });
      }
      filter.orderStatus = status;
    }

    // Fetch orders (pre-find hook ensures only Paid transactions)
    const orders = await Order.find(filter).sort({ createdAt: -1 });

    res.status(200).json({
      count: orders.length,
      orders,
    });
  } catch (error) {
    console.error("Error fetching orders by status:", error);
    res.status(500).json({ message: "Server error" });
  }
};
export const getRestaurantsWithOrderStats = async (req, res) => {
  try {
    // 1. Aggregate orders – one document per restaurant + status + type + sponsor
    const orderStats = await Order.aggregate([
      // Optional: only paid orders (remove if you don’t need it)
      // { $match: { "transaction.status": "PAID" } },

      {
        $group: {
          _id: {
            restaurantId: "$restaurantId",
            restaurantName: "$restaurantName",
            status: "$orderStatus",
            typeOfOrder: "$typeOfOrder",
            fromSponsore: "$fromSponsore",
          },
          count: { $sum: 1 },
        },
      },

      // 2. Group again by restaurant only
      {
        $group: {
          _id: "$_id.restaurantId",
          restaurantName: { $first: "$_id.restaurantName" },

          // collect every combination
          details: {
            $push: {
              status: "$_id.status",
              type: "$_id.typeOfOrder",
              sponsored: "$_id.fromSponsore",
              count: "$count",
            },
          },

          totalOrders: { $sum: "$count" },
        },
      },

      // 3. Build the final objects
      {
        $addFields: {
          // ---- STATUS COUNTS ----
          statusCounts: {
            $reduce: {
              input: "$details",
              initialValue: {
                Pending: 0,
                Preparing: 0,
                Cooked: 0,
                Delivering: 0,
                Completed: 0,
                Cancelled: 0,
              },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $cond: [
                      { $eq: ["$$this.status", "Pending"] },
                      { Pending: "$$this.count" },
                      {
                        $cond: [
                          { $eq: ["$$this.status", "Preparing"] },
                          { Preparing: "$$this.count" },
                          {
                            $cond: [
                              { $eq: ["$$this.status", "Cooked"] },
                              { Cooked: "$$this.count" },
                              {
                                $cond: [
                                  { $eq: ["$$this.status", "Delivering"] },
                                  { Delivering: "$$this.count" },
                                  {
                                    $cond: [
                                      { $eq: ["$$this.status", "Completed"] },
                                      { Completed: "$$this.count" },
                                      { Cancelled: "$$this.count" },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },

          // ---- TYPE COUNTS ----
          typeCounts: {
            $reduce: {
              input: "$details",
              initialValue: { Delivery: 0, Takeaway: 0, DineIn: 0 },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $switch: {
                      branches: [
                        { case: { $eq: ["$$this.type", "Delivery"] }, then: { Delivery: "$$this.count" } },
                        { case: { $eq: ["$$this.type", "Takeaway"] }, then: { Takeaway: "$$this.count" } },
                        { case: { $eq: ["$$this.type", "DineIn"] }, then: { DineIn: "$$this.count" } },
                      ],
                      default: {},
                    },
                  },
                ],
              },
            },
          },

          // ---- SPONSOR COUNTS ----
          sponsorCounts: {
            $reduce: {
              input: "$details",
              initialValue: { sponsored: 0, regular: 0 },
              in: {
                $mergeObjects: [
                  "$$value",
                  {
                    $cond: [
                      { $eq: ["$$this.sponsored", true] },
                      { sponsored: "$$this.count" },
                      { regular: "$$this.count" },
                    ],
                  },
                ],
              },
            },
          },
        },
      },

      // 4. Final clean projection
      {
        $project: {
          _id: 0,
          restaurantId: "$_id",
          restaurantName: 1,
          totalOrders: 1,
          byStatus: "$statusCounts",
          byType: "$typeCounts",
          bySponsor: "$sponsorCounts",
        },
      },

      { $sort: { totalOrders: -1 } },
    ]);

    // ---------------------------------------------------------
    // OPTIONAL: Include restaurants that have ZERO orders
    // ---------------------------------------------------------
    const allRestaurants = await Restaurant.find({}, "name").lean();
    const statsMap = new Map(
      orderStats.map((s) => [s.restaurantId.toString(), s])
    );

    const finalResult = allRestaurants.map((rest) => {
      const found = statsMap.get(rest._id.toString());
      if (found) return found;

      return {
        restaurantId: rest._id,
        restaurantName: rest.name,
        totalOrders: 0,
        byStatus: { Pending: 0, Preparing: 0, Cooked: 0, Delivering: 0, Completed: 0, Cancelled: 0 },
        byType: { Delivery: 0, Takeaway: 0, DineIn: 0 },
        bySponsor: { sponsored: 0, regular: 0 },
      };
    });

    res.status(200).json({
      success: true,
      count: finalResult.length,
      data: finalResult,
    });
  } catch (error) {
    console.error("Error fetching full restaurant stats:", error);
    res.status(500).json({
      success: false,
      message: "Server Error",
      error: error.message,
    });
  }
};