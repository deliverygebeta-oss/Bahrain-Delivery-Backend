import Balance, { REQUESTER_TYPES, TRANSACTION_TYPES } from "../models/Balance.js";
import Restaurant from "../models/restaurantModel.js";
import { TRANSACTION_STATUSES } from "../models/Transaction.js";
import axios from "axios";
import crypto from "crypto";
/************************************************************
 * 1️⃣ GET TOTAL USER BALANCE
 ************************************************************/
export const getBalance = async (req, res, next) => {
  try {
    const userId = req.user?._id;

    let requesterId;


  
    if (!userId) {
      return res.status(401).json({ status: "fail", message: "User not authenticated." });
    }

    if (req.user.role === "Delivery_Person") {
      requesterId = req.user._id;
    } else if (req.user.role === "Manager") {
      const restaurant = await Restaurant.findOne({ managerId: req.user._id });
      if (!restaurant) {
        return res.status(404).json({ status: "fail", message: "Restaurant not found." });
      }
      requesterId = restaurant._id;
    }

    const balance = await Balance.calculateTotal(requesterId);
    const amount = parseFloat(balance.toString());

    res.status(200).json({
      status: "success",
      message: "Total balance retrieved successfully.",
      data: { amount, currency: "ETB" },
    });
  } catch (error) {
    next(error);
  }
};


/************************************************************
 * 2️⃣ CHAPA — SEND TRANSFER
 ************************************************************/
export const sendChapaTransfer = async ({ accountName, accountNumber, amount, bankCode }) => {
  const payload = {
    account_name: accountName,
    account_number: "0937609277",
    amount: amount.toString(),
    currency: "ETB",
    reference: "REF-" + Date.now(),
    bank_code: bankCode,
  };

  const response = await axios.post("https://api.chapa.co/v1/transfers", payload, {
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
      "Chapa-Signature": process.env.CHAPA_SIGNATURE,
    },
  });

  

  return response.data;
};


/************************************************************
 * 3️⃣ INIT WITHDRAW → RETURNS USER BALANCE + BANK LIST
 ************************************************************/
export const initWithdraw = async (req, res) => {
  try {
    const user = req.user;

    if (!user?._id) {
      return res.status(401).json({ status: "fail", message: "User not authenticated." });
    }

    let requesterId;

    if (user.role === "Delivery_Person") {
      requesterId = user._id;
    } else if (user.role === "Manager") {
      const restaurant = await Restaurant.findOne({ managerId: user._id });
      if (!restaurant) {
        return res.status(404).json({
          status: "fail",
          message: "Restaurant not found for this manager.",
        });
      }
      requesterId = restaurant._id;
    }

    const balance = await Balance.calculateTotal(requesterId);
    const availableBalance = parseFloat(balance || 0);

    const response = await axios.get("https://api.chapa.co/v1/banks", {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
    });

    const banks = response.data.data;
    const mobileBanks = banks.filter(bank => [855, 128].includes(bank.id)); // TeleBirr + CBE birr

    return res.status(200).json({
      status: "success",
      data: {
        balance: availableBalance,
        banks: mobileBanks,
        phone: user.phone,
        name: `${user.firstName} ${user.lastName}`,
        role: user.role,
      },
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Initialization failed",
      error: error.response?.data || error.message,
    });
  }
};


/************************************************************
 * 4️⃣ REQUEST WITHDRAW → SEND MONEY IMMEDIATELY
 ************************************************************/
export const requestWithdraw = async (req, res, next) => {
  try {
    const user = req.user;
    const { amount, bankId, note } = req.body;
console.log("sdfadsfs")
    if (!user?._id) {
      return res.status(401).json({ status: "fail", message: "User not authenticated." });
    }

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: "fail", message: "Invalid withdrawal amount." });
    }

    if (!bankId) {
      return res.status(400).json({ status: "fail", message: "Bank is required." });
    }

    /***********************
     * Determine requester
     ***********************/
    let requesterId;
    let requesterType;

    if (user.role === "Delivery_Person") {
      requesterId = user._id;
      requesterType = REQUESTER_TYPES.Delivery;
    } else if (user.role === "Manager") {
      const restaurant = await Restaurant.findOne({ managerId: user._id });
      if (!restaurant) {
        return res.status(404).json({ status: "fail", message: "Restaurant not found." });
      }
      requesterId = restaurant._id;
      requesterType = REQUESTER_TYPES.Restaurant;
    }

    /***********************
     * Check balance
     ***********************/
    const balance = await Balance.calculateTotal(requesterId);
    const availableBalance = parseFloat(balance || 0);

    if (availableBalance < amount) {
      return res.status(400).json({ status: "fail", message: "Insufficient balance." });
    }

    /***********************
     * Auto-filled values
     ***********************/
    // Remove country code (+251) and ensure leading '09...' for the account number
    let accountNumber = user.phone;
    if (accountNumber.startsWith('+251')) {
      accountNumber = accountNumber.replace('+251', '');
      if (accountNumber.length === 9 && accountNumber.startsWith('9')) {
        accountNumber = '0' + accountNumber;
      }
    }
    
    const accountName = `${user.firstName} ${user.lastName}`;

    /***********************
     * Save transaction first
     ***********************/
    let withdraw = await Balance.create({
      requesterType,
      restaurantId: requesterType === REQUESTER_TYPES.Restaurant ? requesterId : undefined,
      deliveryId: requesterType === REQUESTER_TYPES.Delivery ? requesterId : undefined,
      amount,
      type: TRANSACTION_TYPES.Withdraw,
      note,
      status: TRANSACTION_STATUSES.PROCESSING,
      bankId,
      accountName,
      accountNumber,
    });

    /***********************
     * CHAPA PAYOUT
     ***********************/
    let chapaResponse;

    try {
      chapaResponse = await sendChapaTransfer({
        accountName,
        accountNumber,
        amount,
        bankCode: bankId,
      });
    } catch (error) {
      withdraw.status = TRANSACTION_STATUSES.FAILED;
      await withdraw.save();

      return res.status(500).json({
        status: "fail",
        message: "Chapa payout failed.",
        error: error,
      });
    }

    withdraw.status = TRANSACTION_STATUSES.SUCCESS;
    withdraw.chapaResponse = chapaResponse;
    await withdraw.save();

    return res.status(200).json({
      status: "success",
      message: "Withdrawal successful!",
      data: {
        withdraw,
        remainingBalance: availableBalance - amount,
        chapa: chapaResponse,
      },
    });
  } catch (error) {
    next(error);
  }
};


/************************************************************
 * 5️⃣ USER TRANSACTION HISTORY
 ************************************************************/
export const getTransactionHistory = async (req, res) => {
  try {
    const user = req.user;

    let requesterId;
    let requesterType;

    if (user.role === "Delivery_Person") {
      requesterId = user._id;
      requesterType = REQUESTER_TYPES.Delivery;
    } else if (user.role === "Manager") {
      const restaurant = await Restaurant.findOne({ managerId: user._id });
      if (!restaurant) {
        return res.status(404).json({ status: "fail", message: "No restaurant found" });
      }
      requesterId = restaurant._id;
      requesterType = REQUESTER_TYPES.Restaurant;
    } else {
      return res.status(403).json({ status: "fail", message: "Unauthorized role" });
    }

    const transactions = await Balance.getTransactionsWithRunningBalance(requesterId);

    const formattedTransactions = transactions.map(tx => ({
      id: tx._id,
      type: tx.type,
      amount: parseFloat(tx.amount.toString()),
      currency: tx.currency,
      status: tx.status,
      note: tx.note,
      createdAt: tx.createdAt,
      currentBalance: parseFloat(tx.currentBalance?.toString() || "0"),
    }));

    const totalBalance = await Balance.calculateTotal(requesterId);

    res.status(200).json({
      status: "success",
      requesterType,
      totalBalance: parseFloat(totalBalance?.toString() || "0"),
      transactions: formattedTransactions,
    });
  } catch (error) {
    console.error("Error fetching transaction history:", error);
    res.status(500).json({
      status: "error",
      message: "Something went wrong while fetching history",
    });
  }
};


/************************************************************
 * 6️⃣ WITHDRAW HISTORY (ADMIN SIDE)
 ************************************************************/
export const getWithdrawHistory = async (req, res) => {
  try {
    const requesterType = req.params.requesterType;
    const { type = "Withdraw", status } = req.query;

    if (!Object.values(REQUESTER_TYPES).includes(requesterType)) {
      return res.status(400).json({ status: "fail", message: "Invalid requester type" });
    }

    const query = { requesterType, type };
    if (status) query.status = status;

    let historyQuery;

    if (requesterType === REQUESTER_TYPES.Delivery) {
      historyQuery = Balance.find(query)
        .populate("deliveryId", "firstName lastName phone role")
        .sort({ createdAt: -1 });
    } else {
      historyQuery = Balance.find(query)
        .populate("restaurantId", "name phone")
        .sort({ createdAt: -1 });
    }

    const history = await historyQuery;

    const formatted = history.map(item => ({
      _id: item._id,
      requesterType: item.requesterType,
      deliveryId: item.deliveryId,
      restaurantId: item.restaurantId,
      amount: item.amount,
      type: item.type,
      note: item.note,
      status: item.status,
      createdAt: item.createdAt,
      bankId: item.bankId,
    }));

    return res.status(200).json({
      status: "success",
      results: formatted.length,
      data: formatted,
    });
  } catch (error) {
    console.error("Error fetching withdraw history:", error);
    return res.status(500).json({
      status: "error",
      message: "Something went wrong",
      error: error.message,
    });
  }
};


export const chapaTransferApproval = async (req, res) => {
  try {
    const approvalSecret = process.env.CHAPA_SIGNATURE;

    if (!approvalSecret) {
      console.error("CHAPA_APPROVAL_SECRET is not set");
      return res.status(500).send("Server configuration error");
    }

    console.log("req.headers", req.headers);
    const receivedSignature = req.headers["chapa-signature"]?.toString().toLowerCase();

    if (!receivedSignature) {
      console.log("Missing Chapa-Signature header");
      return res.status(400).send("Missing signature");
    }

    // IMPORTANT: Get raw body BEFORE any parsing (critical for signature verification)
    const rawBody = req.rawBody || req.body; // We'll explain how to get rawBody below

    // If you're using Express with JSON parser, you MUST capture raw body first!
    let bodyRaw;
    if (Buffer.isBuffer(rawBody)) {
      bodyRaw = rawBody;
    } else if (typeof rawBody === "string") {
      bodyRaw = rawBody;
    } else {
      bodyRaw = JSON.stringify(req.body); // fallback, but not safe if parser already ran
    }

    // Generate expected signature: HMAC-SHA256 of raw request body using approval secret
    const expectedSignature = crypto
      .createHmac("sha256", approvalSecret)
      .update(bodyRaw)                // ← This is the FIX: hash the RAW BODY
      .digest("hex")
      .toLowerCase();


    console.log("Received signature :", receivedSignature);
    console.log("Expected signature :", expectedSignature);

    // Secure comparison (timing-safe)
    if (!crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) {
      console.log("Signature mismatch → Transfer REJECTED");
      return res.status(400).send("Invalid signature");
    }

    // if (receivedSignature !== approvalSecret) {
    //   console.log("Signature mismatch → Transfer REJECTED");
    //   return res.status(400).send("Invalid signature");
    // }
  


    // Signature is valid → Approve transfer
    console.log("Signature valid → Transfer APPROVED");
    console.log("Transfer Details:", req.body);

    // Optional: Add your own business logic here
    // e.g., check amount, reference uniqueness, account number, etc.

    return res.status(200).send("Approved");

  } catch (err) {
    console.error("Server Error in Chapa Approval:", err);
    return res.status(500).send("Internal server error");
  }
};
//export default chapaTransferApproval;