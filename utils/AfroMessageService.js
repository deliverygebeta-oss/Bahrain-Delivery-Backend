import axios from "axios";
import AppError from "./appError.js"; // adjust the import path as needed

/**
 * AfroMessageService
 * Unified handler for sending OTPs and regular SMS messages.
 */
class AfroMessageService {
  constructor() {
    this.apiToken = process.env.AFROMESSAGE_API_TOKEN;
    this.senderName = process.env.AFROMESSAGE_SENDER_NAME;
    this.identifierId = process.env.AFROMESSAGE_IDENTIFIER_ID;
    this.baseUrl = "https://api.afromessage.com/api";

    if (!this.apiToken) {
      throw new Error("AFROMESSAGE_API_TOKEN is required");
    }
  }

  /**
   * 🔧 Internal request handler
   */
  async _request(endpoint, params) {
    try {
      const response = await axios.get(`${this.baseUrl}/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        params,
        timeout: 30000,
      });

      const data = response.data;
      if (data.acknowledge === "success") {
        return { success: true, data: data.response };
      }

      return {
        success: false,
        error: data.response || "AfroMessage request failed",
      };
    } catch (error) {
      console.error(
        `AfroMessage ${endpoint} error:`,
        error.response?.data || error.message
      );
      throw new AppError(`AfroMessage API request failed: ${endpoint}`, 500);
    }
  }

  // ============================================================
  // 🔐 OTP HANDLING
  // ============================================================

  /**
   * 📤 Send OTP
   */
  async sendOTP(phone, options = {}) {
    const {
      codeLength = 6,
      codeType = 0, // 0=numeric, 1=alphabetic, 2=alphanumeric
      ttlSeconds = 300, // 5 minutes
      messagePrefix = "Your verification code is",
      messagePostfix = ". Do not share this code.",
      spacesBeforeCode = 1,
      spacesAfterCode = 0,
    } = options;

    const params = new URLSearchParams({
      to: phone,
      len: codeLength,
      t: codeType,
      ttl: ttlSeconds,
      pr: messagePrefix,
      ps: messagePostfix,
      sb: spacesBeforeCode,
      sa: spacesAfterCode,
    });

    if (this.identifierId) params.append("from", this.identifierId);
    if (this.senderName) params.append("sender", this.senderName);

    const result = await this._request("challenge", params);

    if (result.success) {
      const res = result.data;
      return {
        success: true,
        type: "otp",
        verificationId: res.verificationId,
        messageId: res.message_id,
        message: res.message,
        to: res.to,
        code: res.code, // Only for testing — remove in production
      };
    }

    return { success: false, error: result.error };
  }

  /**
   * ✅ Verify OTP
   */
  async verifyOTP(code, phone = null, verificationId = null) {
    if (!phone && !verificationId) {
      throw new AppError("Either phone or verificationId is required", 400);
    }

    const params = new URLSearchParams({ code });
    if (verificationId) params.append("vc", verificationId);
    if (phone) params.append("to", phone);

    const result = await this._request("verify", params);

    if (result.success) {
      const res = result.data;
      return {
        success: true,
        verified: true,
        phone: res.phone,
        verificationId: res.verificationId,
      };
    }

    return {
      success: false,
      verified: false,
      error: result.error || "Invalid or expired OTP",
    };
  }

  // ============================================================
  // 💬 REGULAR MESSAGING
  // ============================================================

  /**
   * ✉️ Send a standard SMS message
   */
  async sendMessage(phone, message) {
    const params = new URLSearchParams({
      to: phone,
      message,
    });

    if (this.identifierId) params.append("from", this.identifierId);
    if (this.senderName) params.append("sender", this.senderName);

    const result = await this._request("send", params);

    if (result.success) {
      const res = result.data;
      return {
        success: true,
        type: "message",
        messageId: res.message_id,
        message: res.message,
        to: res.to,
      };
    }

    return { success: false, error: result.error };
  }
}

export default AfroMessageService;
