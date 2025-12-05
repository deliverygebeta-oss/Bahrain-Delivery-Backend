import Balance, { REQUESTER_TYPES, TRANSACTION_TYPES } from "../models/Balance.js";
import Restaurant from "../models/restaurantModel.js";
import { TRANSACTION_STATUSES } from "../models/Transaction.js";
import axios from "axios";
import crypto from "crypto";

/************************************************************
 *  Helper: Get Requester (Delivery or Restaurant)
 ************************************************************/
async function getRequester(req) {
  const user = req.user;

  if (!user?._id) return null;

  if (user.role === "Delivery_Person") {
    return {
      requesterId: user._id,
      requesterType: REQUESTER_TYPES.Delivery,
    };
  }

  if (user.role === "Manager") {
    const restaurant = await Restaurant.findOne({ managerId: user._id });
    if (!restaurant) return null;

    return {
      requesterId: restaurant._id,
      requesterType: REQUESTER_TYPES.Restaurant,
    };
  }

  return null;
}
const autoValidateChapaTransfer = async (withdrawId) => {
  try {
    const withdraw = await Balance.findById(withdrawId);

    if (!withdraw) {
      console.log("❌ Withdraw not found:", withdrawId);
      return;
    }

    if (!withdraw.chapaResponse?.reference) {
      console.log("❌ No Chapa reference found on withdraw:", withdrawId);
      return;
    }

    const reference = withdraw.chapaResponse.data.reference;

    // Call Chapa verify API
    const response = await axios.get(
      `https://api.chapa.co/v1/transfers/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        },
      }
    );

    const result = response.data;

    if (result.status !== "success") {
      console.log("❌ Transfer still pending or failed:", reference);
      return;
    }

    const chapaStatus = result.data.status; // success, failed, pending

    console.log("🔍 Chapa status:", chapaStatus);

    // Update DB
    if (chapaStatus === "success") {
      withdraw.status = "SUCCESS";
    } else if (chapaStatus === "failed") {
      withdraw.status = "FAILED";
    } else {
      withdraw.status = "PENDING";
    }

    await withdraw.save();

    console.log(`✅ Withdraw ${withdrawId} status updated → ${withdraw.status}`);
  } catch (err) {
    console.error("Auto-validate error:", err.response?.data || err.message);
  }
};

/************************************************************
 * 1️⃣ GET TOTAL USER BALANCE
 ************************************************************/
export const getBalance = async (req, res, next) => {
  try {
    const requester = await getRequester(req);

    if (!requester) {
      return res.status(401).json({ status: "fail", message: "Unauthorized user." });
    }

    const balance = await Balance.calculateTotal(requester.requesterId);

    return res.status(200).json({
      status: "success",
      message: "Total balance retrieved.",
      data: { amount: Number(balance), currency: "ETB" },
    });
  } catch (error) {
    next(error);
  }
};

/************************************************************
 * 2️⃣ Chapa Transfer Helper
 ************************************************************/
export const sendChapaTransfer = async ({ accountName, accountNumber, amount, bankCode, reference }) => {
  const payload = {
    account_name: accountName,
    account_number: accountNumber,
    amount: amount.toString(),
    currency: "ETB",
    reference,
    bank_code: bankCode,
  };

  const response = await axios.post(
    "https://api.chapa.co/v1/transfers",
    payload,
    {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data;
};

/************************************************************
 * 3️⃣ GET CHAPA BALANCE
 ************************************************************/
export const getChapaBalanceETB = async () => {
  
  const response = await axios.get("https://api.chapa.co/v1/balances", {
    headers: {
      Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
    },
  });
  const etb = response.data?.data?.find(b => b.currency === "ETB");

  if (!etb) throw new Error("ETB balance not found on Chapa");
  return {
    available: Number(etb.available_balance || 0),
    ledger: Number(etb.ledger_balance || 0),
  };
};

/************************************************************
 * 4️⃣ INIT WITHDRAW → Return User Balance + Banks
 ************************************************************/
export const initWithdraw = async (req, res) => {
  try {
    const requester = await getRequester(req);
    const user = req.user;

    if (!requester) {
      return res.status(401).json({ status: "fail", message: "Unauthorized user." });
    }

    const balance = await Balance.calculateTotal(requester.requesterId);
console.log("balance", balance);
    const bankRes = await axios.get("https://api.chapa.co/v1/banks", {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
    });

    const mobileBanks = bankRes.data.data.filter(
      bank => [855, 128].includes(bank.id) // Telebirr, CBE Birr
    );

    return res.status(200).json({
      status: "success",
      data: {
        balance: Number(balance),
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
 * 5️⃣ REQUEST WITHDRAW → Money Sent Immediately
 ************************************************************/
export const requestWithdraw = async (req, res, next) => {
  try {
    const user = req.user;
    const { amount, bankId, note } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ status: "fail", message: "Invalid withdrawal amount." });
    }

    const requester = await getRequester(req);

    if (!requester) {
      return res.status(401).json({ status: "fail", message: "Unauthorized user." });
    }

    /***********************
     * 1️⃣ Check Internal Balance
     ***********************/
    const internalBalance = await Balance.calculateTotal(requester.requesterId);

    if (internalBalance < amount) {
      return res.status(400).json({
        status: "fail",
        message: "Insufficient system balance.",
      });
    }

    /***********************
     * 2️⃣ Check Chapa Balance
     *
     ***********************/

    const chapaBalance = await getChapaBalanceETB();
   
    if (chapaBalance.available < amount) {
      return res.status(400).json({
        status: "fail",
        message: "Chapa ETB balance too low.",
        chapaAvailable: chapaBalance.available,
      });
    }

    /***********************
     * 3️⃣ Normalize Phone
     ***********************/
    let accNumber = user.phone.replace("+251", "");
    if (accNumber.startsWith("9") && accNumber.length === 9) {
      accNumber = "0" + accNumber;
    }

    const accName = `${user.firstName} ${user.lastName}`;

    /***********************
     * 4️⃣ Create Withdrawal Record (PENDING)
     ***********************/
    const withdrawal = await Balance.create({
      requesterType: requester.requesterType,
      deliveryId: requester.requesterType === REQUESTER_TYPES.Delivery ? requester.requesterId : undefined,
      restaurantId: requester.requesterType === REQUESTER_TYPES.Restaurant ? requester.requesterId : undefined,
      originalAmount: Number(amount),
      type: TRANSACTION_TYPES.Withdraw,
      note,
      bankId,
      accountName: accName,
      accountNumber: accNumber,
      status: TRANSACTION_STATUSES.PENDING,
    });

    /***********************
     * 5️⃣ Send Transfer
     ***********************/
    let transferRes;

    try {
      transferRes = await sendChapaTransfer({
        accountName: accName,
        accountNumber: accNumber,
        amount,
        bankCode: bankId,
        reference: withdrawal._id.toString(),
      });
    } catch (err) {
      withdrawal.status = TRANSACTION_STATUSES.FAILED;
      await withdrawal.save();

      return res.status(500).json({
        status: "fail",
        message: "Chapa payout failed.",
        error: err.response?.data || err.message,
      });
    }

    withdrawal.status = TRANSACTION_STATUSES.PROCESSING;
    withdrawal.chapaResponse = transferRes;
    await withdrawal.save();

    autoValidateChapaTransfer(withdrawal._id); // FIXED HERE ✔✔✔

    return res.status(200).json({
      status: "success",
      message: "Withdrawal initiated.",
      data: {
        withdrawal,
        remainingBalance: Number(internalBalance) - Number(amount),
        chapaResponse: transferRes,
      },
    });
  } catch (error) {
    next(error);
  }
};

/************************************************************
 * 6️⃣ USER TRANSACTION HISTORY
 ************************************************************/
export const getTransactionHistory = async (req, res) => {
  try {
    const requester = await getRequester(req);

    if (!requester) {
      return res.status(401).json({ status: "fail", message: "Unauthorized user." });
    }

    const transactions = await Balance.getTransactionsWithRunningBalance(requester.requesterId);

    const formatted = transactions.map(tx => ({
      id: tx._id,
      type: tx.type,
      originalAmount: Number(tx.originalAmount),
      netAmount: Number(tx.netAmount),
      fee: Number(tx.fee),
      bankId: tx.bankId,
      currency: tx.currency,
      status: tx.status,
      note: tx.note,
      createdAt: tx.createdAt,
      currentBalance: Number(tx.currentBalance || 0),
    }));

    const totalBalance = await Balance.calculateTotal(requester.requesterId);

    return res.status(200).json({
      status: "success",
      totalBalance: Number(totalBalance),
      transactions: formatted,
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Failed to fetch history",
    });
  }
};

/************************************************************
 * 7️⃣ ADMIN WITHDRAW HISTORY
 ************************************************************/
export const getWithdrawHistory = async (req, res) => {
  try {
    const requesterType = req.params.requesterType;

    if (!Object.values(REQUESTER_TYPES).includes(requesterType)) {
      return res.status(400).json({ status: "fail", message: "Invalid requester type." });
    }

    const query = { requesterType, type: TRANSACTION_TYPES.Withdraw };

    if (req.query.status) query.status = req.query.status;

    let historyQuery = Balance.find(query).sort({ createdAt: -1 });

    if (requesterType === REQUESTER_TYPES.Delivery) {
      historyQuery = historyQuery.populate("deliveryId", "firstName lastName phone");
    } else {
      historyQuery = historyQuery.populate("restaurantId", "name phone");
    }

    const results = await historyQuery;

    const formatted = results.map(tx => ({
      id: tx._id,
      requesterType,
      originalAmount: Number(tx.originalAmount),
      netAmount: Number(tx.netAmount),
      fee: Number(tx.fee),
      bankId: tx.bankId,
      status: tx.status,
      note: tx.note,
      createdAt: tx.createdAt,
      deliveryId: tx.deliveryId,
      restaurantId: tx.restaurantId,
    }));

    return res.status(200).json({
      status: "success",
      count: formatted.length,
      data: formatted,
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Something went wrong",
    });
  }
};

/************************************************************
 * 8️⃣ CHAPA WEBHOOK (FINAL APPROVAL)
 ************************************************************/
export const chapaTransferApproval = async (req, res) => {
  try {
    const secret = process.env.CHAPA_SIGNATURE;

    const receivedSig = req.headers["chapa-signature"];
    if (!receivedSig) return res.status(400).send("Missing signature");

    const expected = crypto
      .createHmac("sha256", secret)
      .update(secret)
      .digest("hex")
      .toLowerCase();

    if (receivedSig.toLowerCase() !== expected) {
      return res.status(400).send("Invalid signature");
    }
    const { reference } = req.body;
    const withdraw = await Balance.findById(reference);

    if (!withdraw) return res.status(400).send("Withdraw record not found");
    withdraw.chapaResponse = req.body;
    await withdraw.save();

    return res.status(200).send("Approved");
  } catch (err) {
    return res.status(500).send("Internal server error");
  }
};
