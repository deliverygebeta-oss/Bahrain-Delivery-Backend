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
      required() {
        return this.requesterType === REQUESTER_TYPES.Restaurant;
      },
      index: true,
    },

    deliveryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required() {
        return this.requesterType === REQUESTER_TYPES.Delivery;
      },
      index: true,
    },

    // ALWAYS store money in 3 fields:
    // 1️⃣ originalAmount (user entered)
    // 2️⃣ fee (system deducted)
    // 3️⃣ netAmount (stored usable amount)

    originalAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
    },

    fee: {
      type: mongoose.Schema.Types.Decimal128,
      default: 0,
    },

    netAmount: {
      type: mongoose.Schema.Types.Decimal128,
      required: true,
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

    bankId: String,
    accountName: String,
    accountNumber: String,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/************************************************************
 * 🔹 VIRTUAL: requesterId (auto resolves delivery or restaurant)
 ************************************************************/
balanceSchema.virtual("requesterId").get(function () {
  return this.requesterType === REQUESTER_TYPES.Delivery
    ? this.deliveryId
    : this.restaurantId;
});

/************************************************************
 * 🔹 PRE-SAVE: Auto-calculate fee & netAmount on Deposits ONLY
 ************************************************************/
balanceSchema.pre("validate", function (next) {
  // Only run for NEW deposit records
  if (!this.isNew || this.type !== TRANSACTION_TYPES.Deposit) {
    this.netAmount = this.originalAmount;
    return next();
  }

  const deliveryFee = parseFloat(process.env.DELIVERY_DEPOSIT_FEE || "0.1"); // 10%
  const restaurantFee = parseFloat(process.env.RESTAURANT_DEPOSIT_FEE || "0.08"); // 8%

  const original = parseFloat(this.originalAmount.toString());

  let feePercentage =
    this.requesterType === REQUESTER_TYPES.Delivery ? deliveryFee : restaurantFee;

  const fee = parseFloat((original * feePercentage).toFixed(2));
  const net = parseFloat((original - fee).toFixed(2));

  this.fee = fee;
  this.netAmount = net;

  next();
});

/************************************************************
 * 🔹 STATIC: Calculate total usable balance
 * Balance = SUM(Deposits) - SUM(Success Withdrawals)
 ************************************************************/
balanceSchema.statics.calculateTotal = async function (requesterId) {
  const result = await this.aggregate([
    {
      $match: {
        $or: [
          { deliveryId: requesterId },
          { restaurantId: requesterId }
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
          }
        }
      }
    }
  ]);

  return result.length > 0 ? result[0].total : 0;
};

/************************************************************
 * 🔹 STATIC: Running balance history
 ************************************************************/
balanceSchema.statics.getTransactionsWithRunningBalance = async function (requesterId) {
  return await this.aggregate([
    {
      $match: {
        $or: [
          { deliveryId: requesterId },
          { restaurantId: requesterId }
        ]
      }
    },
    { $sort: { createdAt: 1 } },
    {
      $setWindowFields: {
        partitionBy: requesterId,
        sortBy: { createdAt: 1 },
        output: {
          currentBalance: {
            $sum: {
              $cond: [
                { $eq: ["$type", TRANSACTION_TYPES.Deposit] },
                "$netAmount",
                { $multiply: ["$netAmount", -1] }
              ]
            },
            window: { documents: ["unbounded", "current"] }
          }
        }
      }
    }
  ]);
};

const Balance = mongoose.model("Balance", balanceSchema);
export default Balance;
