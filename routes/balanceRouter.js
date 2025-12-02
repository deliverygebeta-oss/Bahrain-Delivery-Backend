import express from "express";
import { getBalance, requestWithdraw, getTransactionHistory  ,getWithdrawHistory ,getMobileMoneyBanks } from "../controllers/balanceController.js";
import { protect,restrictTo } from "../controllers/authController.js"; // optional, if you have authentication

const router = express.Router();

// Protect all balance routes
router.use(protect);

// Get current balance
router.get("/", getBalance);

// Request a withdrawal
router.post("/withdraw", requestWithdraw);

router.get("/history", getTransactionHistory );

router.get("/withdraw-history/:requesterType",restrictTo("Admin"), getWithdrawHistory);

router.get("/bank", protect , getMobileMoneyBanks);
export default router;
