const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SwapEvent = sequelize.define(
  "SwapEvent",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    swapId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "swap_id",
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    /**
     * Jenis event yang terjadi pada swap.
     *
     * Contoh:
     * SWAP_CREATED
     * PROCESSING
     * DEPOSIT_DETECTED
     * DEPOSIT_CONFIRMED
     * WITHDRAWAL_SUBMITTED
     * WITHDRAWAL_CONFIRMED
     * COMPLETED
     * FAILED
     * REFUND_CREATED
     * REFUND_SUBMITTED
     * REFUND_COMPLETED
     * REFUND_FAILED
     */
    eventType: {
      type: DataTypes.ENUM(
        "SWAP_CREATED",
        "PROCESSING",
        "DEPOSIT_DETECTED",
        "DEPOSIT_CONFIRMED",
        "WITHDRAWAL_SUBMITTED",
        "WITHDRAWAL_CONFIRMED",
        "COMPLETED",
        "FAILED",
        "REFUND_CREATED",
        "REFUND_SUBMITTED",
        "REFUND_COMPLETED",
        "REFUND_FAILED",
      ),
      allowNull: false,
      field: "event_type",
    },

    /**
     * Status swap pada saat event terjadi.
     */
    status: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    /**
     * Transaction hash jika event
     * berhubungan dengan blockchain.
     */
    txHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "tx_hash",
    },

    /**
     * Block number jika event berasal
     * dari blockchain.
     */
    blockNumber: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "block_number",
    },

    /**
     * Data tambahan event.
     *
     * Contoh:
     * {
     *   amount: "100",
     *   token: "USDT",
     *   poolAddress: "0x...",
     *   reason: "Insufficient pool balance"
     * }
     */
    metadata: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
  },
  {
    tableName: "swap_events",

    timestamps: true,

    createdAt: "created_at",
    updatedAt: false,

    indexes: [
      {
        fields: ["swap_id"],
      },
      {
        fields: ["core_id"],
      },
      {
        fields: ["event_type"],
      },
      {
        fields: ["tx_hash"],
      },
      {
        fields: ["created_at"],
      },
    ],
  },
);

module.exports = SwapEvent;
