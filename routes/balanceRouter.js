import express from "express";
import { getBalance, requestWithdraw, getTransactionHistory  ,getWithdrawHistory ,initWithdraw ,chapaTransferApproval} from "../controllers/balanceController.js";
import { protect,restrictTo } from "../controllers/authController.js"; // optional, if you have authentication

const router = express.Router();

// Protect all balance routes
router.use(protect);

// Get current balance
router.get("/", protect , restrictTo("Delivery_Person","Manager") , getBalance);

// Request a withdrawal
router.post("/withdraw", protect , restrictTo("Delivery_Person","Manager") , requestWithdraw);

router.get("/history",protect, restrictTo("Delivery_Person","Manager") , getTransactionHistory );

router.get("/withdraw-history/:requesterType",restrictTo("Admin"), getWithdrawHistory);

router.get("/initialize-withdraw", protect , restrictTo("Delivery_Person","Manager") , initWithdraw);

router.post("/chapa-transfer-approval", chapaTransferApproval);

export default router;
