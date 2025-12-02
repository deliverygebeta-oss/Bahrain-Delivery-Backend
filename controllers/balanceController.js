import Balance, { REQUESTER_TYPES, TRANSACTION_TYPES } from "../models/Balance.js";
import Restaurant from "../models/restaurantModel.js";
import { TRANSACTION_STATUSES } from "../models/Transaction.js";
import axios from "axios";

export const getBalance = async (req, res, next) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({
        status: "fail",
        message: "User not authenticated.",
      });
    }

    // ✅ Calculate total balance using static method
    const balance = await Balance.calculateTotal(userId);
    const amount = parseFloat(balance.toString());

    res.status(200).json({
      status: "success",
      message: "Total balance retrieved successfully.",
      data: {
        amount,
        currency: "ETB",
      },
    });
  } catch (error) {
    next(error);
  }
};

export const requestWithdraw = async (req, res, next) => {
  try {
    const user = req.user;
    const { amount, note } = req.body;

    if (!user?._id) {
      return res.status(401).json({
        status: "fail",
        message: "User not authenticated.",
      });
    }

    // ✅ Validate amount
    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        status: "fail",
        message: "Please provide a valid withdrawal amount greater than 0.",
      });
    }

    let requesterId;
    let requesterType;

    // Determine requester based on role
    if (user.role === 'Delivery_Person') {
      requesterId = user._id;
      requesterType = REQUESTER_TYPES.Delivery;
    } else if (user.role === "Manager") {
      // Fetch the restaurant managed by this manager
      const restaurant = await Restaurant.findOne({ managerId: user._id });
      if (!restaurant) {
        return res.status(404).json({
          status: "fail",
          message: "No restaurant found for this manager.",
        });
      }
      requesterId = restaurant._id;
      requesterType = REQUESTER_TYPES.Restaurant;
    } else {
      return res.status(403).json({
        status: "fail",
        message: "Unauthorized role for withdrawal.",
      });
    }

    // ✅ Compute current balance
    const currentBalance = await Balance.calculateTotal(requesterId);
    const availableBalance = parseFloat(currentBalance?.toString() || "0");

    if (availableBalance < amount) {
      return res.status(400).json({
        status: "fail",
        message: "Insufficient balance for withdrawal.",
      });
    }

    // ✅ Create withdrawal transaction
    const withdraw = await Balance.create({
      requesterType,
      restaurantId:
        requesterType === REQUESTER_TYPES.Restaurant ? requesterId : undefined,
      deliveryId:
        requesterType === REQUESTER_TYPES.Delivery ? requesterId : undefined,
      amount,
      type: TRANSACTION_TYPES.Withdraw,
      note,
      status: TRANSACTION_STATUSES.PENDING, // Admin can later approve it
    });

    res.status(201).json({
      status: "success",
      message: "Withdrawal request submitted successfully.",
      data: {
        withdraw,
        remainingBalance: availableBalance - amount,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getTransactionHistory = async (req, res) => {
  try {
    const user = req.user; // Auth middleware sets req.user
    let requesterId;
    let requesterType;
    // Determine role and requester
    if (user.role === 'Delivery_Person') {
      requesterId = user._id;
      requesterType = REQUESTER_TYPES.Delivery;
    } else if (user.role === 'Manager') {
      // Manager: fetch their restaurant(s) first
      const restaurant = await Restaurant.findOne({ managerId: user._id });
      if (!restaurant) {
        return res.status(404).json({
          status: "fail",
          message: "No restaurant found for this manager",
        });
      }
      requesterId = restaurant._id;
      requesterType = REQUESTER_TYPES.Restaurant;
    } else {
      return res.status(403).json({
        status: "fail",
        message: "Unauthorized role",
      });
    }

    // Fetch transactions with running balance
    const transactions = await Balance.getTransactionsWithRunningBalance(requesterId);

    // Format Decimal128 to float
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

    // Total balance
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
export const getWithdrawHistory = async (req, res) => {
  try {
    const requesterType = req.params.requesterType;
    const { type = "Withdraw", status = TRANSACTION_STATUSES.PENDING } = req.query;

    // Validate requester type
    if (!requesterType) {
      return res.status(400).json({
        status: "fail",
        message: "Requester type is required",
      });
    }

    if (!Object.values(REQUESTER_TYPES).includes(requesterType)) {
      return res.status(400).json({
        status: "fail",
        message: "Invalid requester type",
      });
    }

    // Base query
    const query = {
      requesterType,
      type, // ✅ Filter by type (Deposit or Withdraw)
      status, // ✅ Filter by status (default: PENDING)
    };

    // Fetch data based on requester type
    let historyQuery;

    if (requesterType === REQUESTER_TYPES.Delivery) {
      historyQuery = Balance.find(query)
        .populate("deliveryId", "firstName lastName phone profilePicture role")
        .sort({ createdAt: -1 });
    } else if (requesterType === REQUESTER_TYPES.Restaurant) {
      historyQuery = Balance.find(query)
        .populate("restaurantId", "name phone profilePicture")
        .sort({ createdAt: -1 });
    }

    const History = await historyQuery;

    // Format response — removing extra nested requesterId, keeping main fields only
    const formattedHistory = History.map((item) => ({
      _id: item._id,
      requesterType: item.requesterType,
      deliveryId: item.deliveryId,
      restaurantId: item.restaurantId,
      amount: item.amount,
      currency: item.currency,
      type: item.type,
      note: item.note,
      status: item.status,
      fee: item.fee,
      createdAt: item.createdAt,
    }));

    return res.status(200).json({
      status: "success",
      results: formattedHistory.length,
      data: formattedHistory,
    });
  } catch (error) {
    console.error("❌ Error fetching withdraw history:", error);
    return res.status(500).json({
      status: "error",
      message: "Something went wrong",
      error: error.message,
    });
  }
};


export const getMobileMoneyBanks = async (req, res) => {
  try {
    const response = await axios.get("https://api.chapa.co/v1/banks", {
      headers: {
        Authorization: `Bearer ${process.env.CHAPA_SECRET_KEY}`,
      },
    });

    const banks = response.data.data;

    // Select telebirr (id: 855) and CBEBirr (id: 128)
    const mobileBanks = banks.filter(bank =>
      [855, 128].includes(bank.id)
    );

    return res.status(200).json({
      status: "success",
      data: mobileBanks,
    });

  } catch (error) {
    console.error("Error fetching bank:", error.response?.data || error.message);

    return res.status(500).json({
      status: "error",
      message: "Something went wrong",
      error: error.response?.data || error.message,
    });
  }
};
