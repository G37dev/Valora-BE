const formatEarnError = (error) => {
  if (!error) {
    return "Unknown error.";
  }

  const message = error.shortMessage || error.message || String(error);

  // ERC20 allowance
  if (
    message.includes("ERC20InsufficientAllowance") ||
    message.includes("InsufficientAllowance") ||
    message.includes("0xfb8f41b2")
  ) {
    return (
      "ERC20 allowance tidak cukup. " +
      "Smart Wallet harus approve Router terlebih dahulu."
    );
  }

  // Unsupported term
  if (
    message.includes("UnsupportedTerm") ||
    message.includes("unsupported term")
  ) {
    return (
      "term_code tidak tersedia di Earn Pool. " +
      "Pastikan term 90/180 sudah dikonfigurasi beserta APR-nya di Pool."
    );
  }

  // Balance
  if (
    message.includes("ERC20InsufficientBalance") ||
    message.includes("InsufficientBalance")
  ) {
    return (
      "Saldo token Smart Wallet tidak cukup " + "untuk membuat posisi Earn."
    );
  }

  // Already claimed
  if (
    message.includes("AlreadyClaimed") ||
    message.includes("already claimed")
  ) {
    return "Posisi Earn sudah di-claim.";
  }

  return message;
};

module.exports = {
  formatEarnError,
};
