import express from "express";
import {
  getBalance,
  requestWithdraw,
  getTransactionHistory,
  getWithdrawHistory,
  initWithdraw,
  chapaTransferApproval,
} from "../controllers/balanceController.js";

import { protect, restrictTo } from "../controllers/authController.js";

const router = express.Router();

/************************************************************
 * 1️⃣ PUBLIC WEBHOOK (NO AUTH)
 * Chapa servers CANNOT send JWT — must stay public.
 ************************************************************/
router.post("/chapa-transfer-approval", chapaTransferApproval);

/************************************************************
 * 2️⃣ PROTECTED BALANCE ROUTES
 ************************************************************/
router.use(protect);  // All below require authentication

/************************************************************
 * 3️⃣ Delivery + Restaurant Only
 ************************************************************/

// Get current balance
router.get(
  "/",
  restrictTo("Delivery_Person", "Manager"),
  getBalance
);

// Initialize withdraw (banks + user info + balance)
router.get(
  "/initialize-withdraw",
  restrictTo("Delivery_Person", "Manager"),
  initWithdraw
);

// Request withdrawal
router.post(
  "/withdraw",
  restrictTo("Delivery_Person", "Manager"),
  requestWithdraw
);

// Transaction history
router.get(
  "/history",
  restrictTo("Delivery_Person", "Manager"),
  getTransactionHistory
);

/************************************************************
 * 4️⃣ ADMIN ONLY ROUTES
 ************************************************************/
router.get(
  "/withdraw-history/:requesterType",
  restrictTo("Admin"),
  getWithdrawHistory
);

export default router;
