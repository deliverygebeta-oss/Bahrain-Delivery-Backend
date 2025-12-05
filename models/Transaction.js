import mongoose from "mongoose";

// =================================================================== 
// TRANSACTION STATUS CONSTANTS
// ===================================================================
export const TRANSACTION_STATUSES = {
  PENDING: "PENDING",
  PAID: "PAID",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  CANCELLED: "CANCELLED",
  PROCESSING: "PROCESSING",
  SUCCESS: "SUCCESS",
  APPROVED: "APPROVED",

};
// =================================================================== 
// CHAPA-SPECIFIC CONSTANTS
// ===================================================================
export const CHAPA_PAYMENT_STATUS = {
  SUCCESS: "success",
  FAILED: "failed",
  PENDING: "pending",
  PROCESSING: "processing",
};


const chapaPaymentSchema = new mongoose.Schema(
  {
    // Chapa transaction reference (matches our tx_ref format: order-{orderId})
    txRef: {
      type: String,
      required: [true, "Chapa tx_ref is required"],
      trim: true,
      index: true,
    },

    // Chapa's internal reference ID for the transaction
    chapaRefId: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },

    // Chapa checkout URL that was presented to user
    checkoutUrl: {
      type: String,
      trim: true,
    },

    // Amount that was sent to Chapa (for reconciliation)
    chapaAmount: {
      type: mongoose.Schema.Types.Decimal128,
      min: [0, "Amount cannot be negative"],
    },

    // Currency sent to Chapa (should be ETB)
    charpaCurrency: {
      type: String,
      enum: ["ETB", "USD"],
      default: "ETB",
    },

    // Chapa payment method/mode
    chapaMethod: {
      type: String,
      trim: true,
    },

    // Chapa payment type (usually "API" or "Web")
    chapaType: {
      type: String,
      enum: ["API", "WEB", "MOBILE"],
      default: "WEB",
    },

    // When Chapa verified the payment (webhook received)
    chapaVerifiedAt: {
      type: Date,
    },

    // Raw response from Chapa (for debugging & reconciliation)
    chapaResponse: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Error response from Chapa initialization
    chapaError: {
      type: String,
      trim: true,
    },
  },
  { _id: false }
);



 
const transactionSchema = new mongoose.Schema(
  {      
  amount: {
      type: mongoose.Schema.Types.Decimal128,
      required: [true, "Transaction amount is required"],
      min: [0, "Amount cannot be negative"],
    },
  status: {
      type: String,
      enum: {
        values: Object.values(TRANSACTION_STATUSES),
        message: `Transaction status must be one of: ${Object.values(TRANSACTION_STATUSES).join(", ")}`,
      },
      default: TRANSACTION_STATUSES.PENDING,
      required: true,
      index: true,
    },
    currency: {
      type: String,
      enum: ["ETB", "USD"],
      default: "ETB",
      required: true,
    },
    chapaPayment: {
      type: chapaPaymentSchema,
      select: false,
    },
  },
  
  { 
    _id: false,
    timestamps: true, // We handle timestamps manually
  }
);

transactionSchema.methods.markAsPaid = function (gatewayRefId, chapaData = {}) {
  this.status = TRANSACTION_STATUSES.PAID;
  this.gatewayReferenceId = gatewayRefId;
  this.processedAt = new Date();
  this.completedAt = new Date();
  if (chapaData) {
    this.chapaPayment = { ...this.chapaPayment, ...chapaData };
    this.chapaPayment.chapaVerifiedAt = new Date();
  }
  return this;
};

transactionSchema.methods.markAsFailed = function (failureReason, failureDetails) {
  this.status = TRANSACTION_STATUSES.FAILED;
  this.failureReason = failureReason;
  this.failureDetails = failureDetails;
  this.processedAt = new Date();
  return this;
};


transactionSchema.statics.createForOrder = function (orderData) {
  return new this({
    amount: orderData.totalAmount,
    currency: "ETB",
   
    status: TRANSACTION_STATUSES.PENDING,
  });
};

export default transactionSchema;