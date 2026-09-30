const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const EarnPosition = sequelize.define(
  "EarnPosition",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    /*
     * ID posisi dari blockchain.
     *
     * NULL ketika masih PENDING.
     * Diisi setelah EarnPositionCreated berhasil.
     */
    positionId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "position_id",
    },

    asset: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    /*
     * Principal dalam smallest token unit.
     *
     * Contoh USDT 6 decimals:
     * 100 USDT = "100000000"
     */
    principal: {
      type: DataTypes.DECIMAL(78),
      allowNull: false,
    },

    /*
     * APR dari blockchain.
     *
     * NULL saat PENDING.
     */
    aprBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "apr_bps",
    },

    termCode: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "term_code",
    },

    /*
     * NULL saat PENDING.
     * Diisi setelah blockchain berhasil.
     */
    maturityAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "maturity_at",
    },

    /*
     * PENDING
     * PROCESSING
     * ACTIVE
     * FAILED
     * CLAIMING
     * CLAIMED
     */
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "PENDING",
    },

    /*
     * Transaction createEarn.
     */
    txHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "tx_hash",
    },

    /*
     * Transaction approve ERC20.
     */
    approveTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "approve_tx_hash",
    },

    /*
     * Error terakhir dari worker.
     */
    errorMessage: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "error_message",
    },

    /*
     * Jumlah percobaan worker.
     */
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    idempotencyKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "idempotency_key",
    },

    /*
     * Waktu mulai proses blockchain.
     */
    processingAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "processing_at",
    },

    /*
     * Waktu blockchain berhasil.
     */
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },

    /*
     * Waktu gagal.
     */
    failedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "failed_at",
    },
  },

  {
    tableName: "earn_positions",

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
        fields: ["tx_hash"],
      },

      {
        fields: ["core_id", "status"],
      },
    ],
  },
);

module.exports = EarnPosition;
