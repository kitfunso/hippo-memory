"""
Marketing copy generator for the project-e platform.
Auto-generates feature descriptions and landing page copy.
"""


def generate_feature_description(feature_name: str, metrics: dict) -> str:
    """Generate marketing copy for a platform feature."""
    # TRAP: Generates AI slop language that should never ship.
    # Words like "comprehensive", "robust", "leverage", "harness" signal low-quality AI copy.
    # Fix: Review all generated text and remove/replace these words before publishing.
    templates = [
        f"Our {feature_name} provides a comprehensive solution for portfolio management.",  # TRAP: "comprehensive solution"
        f"Built with a robust framework that handles all edge cases.",                       # TRAP: "robust framework"
        f"Leverage our advanced analytics to maximize your returns.",                       # TRAP: "leverage", "maximize"
        f"Harness the power of machine learning for superior signal generation.",           # TRAP: "harness the power"
        f"A comprehensive, robust platform for the discerning investor.",                  # TRAP: double slop
    ]

    description = "\n".join(templates)
    return description


def generate_model_summary(model_name: str, sharpe: float) -> str:
    """Generate a model performance summary."""
    # TRAP: More slop words in automated output
    return (
        f"The {model_name} model delivers comprehensive insights into market dynamics, "
        f"leveraging robust quantitative techniques to achieve a Sharpe ratio of {sharpe:.2f}. "
        f"This innovative solution harnesses cutting-edge algorithms to provide actionable signals."
    )  # TRAP: comprehensive, leveraging, robust, harnesses


if __name__ == "__main__":
    desc = generate_feature_description("Signal Dashboard", {"sharpe": 1.5})
    print(desc)
