import mongoose from "mongoose";
import { TRANSACTION_STATUSES } from "./Transaction.js";

export const REQUESTER_TYPES = {
  Delivery: "Delivery",
  Restaurant: "Restaurant",
};

export const TRANSACTION_TYPES = {
  Deposit: "Deposit",
  Withdraw: "Withdraw",
};

const balanceSchema = new mongoose.Schema(
  {
    requesterType: {
      type: String,
      enum: Object.values(REQUESTER_TYPES),
      required: true,
    },

    restaurantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: function () {
        return this.requesterType === REQUESTER_TYPES.Restaurant;
      },
      index: true,
    },

    deliveryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return this.requesterType === REQUESTER_TYPES.Delivery;
      },
      index: true,
    },

    amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: [true, "Transaction amount is required"],
      min: [0, "Amount cannot be negative"],
    },

    currency: {
      type: String,
      default: "ETB",
      required: true,
    },

    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
    },

    note: {
      type: String,
      trim: true,
      maxlength: 500,
    },

    status: {
      type: String,
      enum: Object.values(TRANSACTION_STATUSES),
      default: TRANSACTION_STATUSES.PENDING,
    },
    chapaResponse: {
      type: Object,
      default: null,
    },
    fee: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0, // Store the deducted amount
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual field to get requesterId dynamically
balanceSchema.virtual("requesterId").get(function () {
  return this.requesterType === REQUESTER_TYPES.Delivery
    ? this.deliveryId
    : this.restaurantId;
});

// Pre-save hook to calculate fee for Deposit transactions using environment variables
balanceSchema.pre("save", function (next) {
  if (this.type === TRANSACTION_TYPES.Deposit) {
    // Parse fee percentages from environment variables
    const deliveryFee = parseFloat(process.env.DELIVERY_DEPOSIT_FEE || "0.1"); // default 10%
    const restaurantFee = parseFloat(process.env.RESTAURANT_DEPOSIT_FEE || "0.08"); // default 8%
    
    let feePercentage = 0;

    if (this.requesterType === REQUESTER_TYPES.Delivery) {
      feePercentage = deliveryFee;
    } else if (this.requesterType === REQUESTER_TYPES.Restaurant) {
      feePercentage = restaurantFee;
    }

    const amount = parseFloat(this.amount.toString());
    const fee = parseFloat((amount * feePercentage).toFixed(2));

    this.fee = fee;
    this.amount = parseFloat((amount - fee).toFixed(2));
  }
  next();
});

// Static method to calculate total balance for a requester
balanceSchema.statics.calculateTotal = async function (requesterId) {
  const result = await this.aggregate([
    {
      $match: {
        $or: [
          { deliveryId: requesterId },
          { restaurantId: requesterId },
        ],
        status: { $in: [TRANSACTION_STATUSES.APPROVED, TRANSACTION_STATUSES.SUCCESS] }
      },
    },
    {
      $group: {
        _id: null,
        total: {
          $sum: {
            $cond: [
              { $eq: ["$type", TRANSACTION_TYPES.Deposit] },
              "$netAmount",
              { $multiply: ["$netAmount", -1] }
            ]
          },
        },
      },
    },
  ]);

  return result.length > 0 ? result[0].total : 0;
};


// Static method to get transactions with running balance using aggregation
balanceSchema.statics.getTransactionsWithRunningBalance = async function (requesterId) {
  const transactions = await this.aggregate([
    {
      $match: {
        $or: [
          { deliveryId: requesterId },
          { restaurantId: requesterId },
        ],
      },
    },
    { $sort: { createdAt: 1 } },
    {
      $setWindowFields: {
        partitionBy: "$requesterType",
        sortBy: { createdAt: 1 },
        output: {
          currentBalance: {
            $sum: {
              $cond: [
                { $eq: ["$type", TRANSACTION_TYPES.Deposit] },
                "$amount",
                { $multiply: ["$amount", -1] },
              ],
            },
            window: { documents: ["unbounded", "current"] },
          },
        },
      },
    },
  ]);

  return transactions;
};

const Balance = mongoose.model("Balance", balanceSchema);
export default Balance;
