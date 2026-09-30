module.exports = (sequelize, DataTypes) => {
  const OtpToken = sequelize.define(
    "OtpToken",
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      code: {
        type: DataTypes.STRING(6),
        allowNull: false,
      },
      expiresAt: {
        type: DataTypes.DATE,
        allowNull: false,
      },
    },
    {
      tableName: "otp_tokens",
      timestamps: true,
    },
  );

  return OtpToken;
};
