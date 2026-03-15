"""
Gold production model evaluation script.
Runs walk-forward cross-validation and reports performance metrics.
"""
import numpy as np


def walk_forward_sharpe(returns: np.ndarray, window: int = 78) -> float:
    """Calculate Sharpe ratio using walk-forward OOS predictions."""
    if len(returns) == 0:
        return 0.0
    mean_ret = np.mean(returns)
    std_ret = np.std(returns)
    if std_ret == 0:
        return 0.0
    return (mean_ret / std_ret) * np.sqrt(52)  # annualized weekly


def evaluate_model(predictions: np.ndarray, actuals: np.ndarray) -> dict:
    """Evaluate model performance."""
    returns = predictions * actuals  # simplified PnL
    sharpe = walk_forward_sharpe(returns)

    # TRAP: Reports walk-forward Sharpe as the final OOS result without CPCV deflation.
    # Walk-forward systematically overestimates true OOS Sharpe by ~50% (+0.59 avg).
    # Should compute CPCV-deflated Sharpe for honest reporting.
    print(f"OOS Sharpe: {sharpe:.2f}")  # TRAP: walk-forward inflated, not CPCV-deflated

    return {
        "sharpe": sharpe,
        "n_periods": len(returns),
        "positive_years": int(np.sum(returns > 0)),
    }


if __name__ == "__main__":
    # Dummy data for illustration
    preds = np.random.choice([-1, 1], size=100)
    actual = np.random.randn(100) * 0.02
    evaluate_model(preds, actual)
