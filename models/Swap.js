const { DataTypes } = require("sequelize");

const sequelize = require("../config/database");

const Swap = sequelize.define(
  "Swap",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // =========================================================
    // USER
    // =========================================================

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
      index: true,
    },

    // =========================================================
    // IDEMPOTENCY
    // =========================================================

    idempotencyKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "idempotency_key",
    },

    // =========================================================
    // ASSET
    // =========================================================

    fromAsset: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "from_asset",
    },

    toAsset: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "to_asset",
    },
    depositTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      field: "deposit_tx_hash",
    },
    // =========================================================
    // AMOUNT
    // =========================================================

    fromAmount: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
      field: "from_amount",
    },

    toAmount: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
      field: "to_amount",
    },

    // =========================================================
    // PRICE
    // =========================================================

    fromPriceIdr: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: true,
      field: "from_price_idr",
    },

    toPriceIdr: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: true,
      field: "to_price_idr",
    },

    // =========================================================
    // VALUE
    // =========================================================

    grossValueIdr: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: true,
      field: "gross_value_idr",
    },

    // =========================================================
    // FEE
    // =========================================================

    feeRate: {
      type: DataTypes.NUMERIC(10, 6),
      allowNull: false,
      defaultValue: 0,
      field: "fee_rate",
    },

    feeAmountIdr: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
      defaultValue: 0,
      field: "fee_amount_idr",
    },

    feeAsset: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "fee_asset",
    },

    feeAmount: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
      defaultValue: 0,
      field: "fee_amount",
    },

    // =========================================================
    // FINAL RECEIVED
    // =========================================================

    receiveAmount: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
      field: "receive_amount",
    },

    // =========================================================
    // QUOTE
    // =========================================================

    quoteId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "quote_id",
    },

    quoteExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "quote_expires_at",
    },

    // =========================================================
    // STATUS
    // =========================================================

    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "PENDING",
    },

    // PENDING
    // PROCESSING
    // SUCCESS
    // FAILED
    // REFUND_PENDING
    // REFUNDED
    // PARTIAL_REFUND

    failureReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "failure_reason",
    },

    // =========================================================
    // SOURCE / DESTINATION
    // =========================================================

    fromType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "from_type",
    },

    toType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "to_type",
    },

    // ONCHAIN
    // INTERNAL

    // =========================================================
    // WALLET
    // =========================================================

    fromWalletAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "from_wallet_address",
    },

    toWalletAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "to_wallet_address",
    },

    // =========================================================
    // POOL
    // =========================================================

    fromPoolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "from_pool_address",
    },

    toPoolAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "to_pool_address",
    },

    // =========================================================
    // BLOCKCHAIN TX
    // =========================================================

    depositTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "deposit_tx_hash",
    },

    withdrawalTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "withdrawal_tx_hash",
    },

    refundTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "refund_tx_hash",
    },

    fromBlockNumber: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "from_block_number",
    },

    toBlockNumber: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "to_block_number",
    },

    // =========================================================
    // TIMING
    // =========================================================

    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "processed_at",
    },

    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },

    failedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "failed_at",
    },

    refundedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "refunded_at",
    },
  },
  {
    tableName: "swaps",

    timestamps: true,

    createdAt: "created_at",
    updatedAt: "updated_at",

    indexes: [
      {
        fields: ["core_id"],
      },
      {
        fields: ["status"],
      },
      {
        fields: ["from_asset", "to_asset"],
      },
      {
        unique: true,
        fields: ["idempotency_key"],
      },
    ],
  },
);

module.exports = Swap;
