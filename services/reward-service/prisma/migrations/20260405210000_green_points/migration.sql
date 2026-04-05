-- User balances + generic green_point_transactions added in 20260405220000_green_point_transactions.
CREATE TABLE "user_green_point_balances" (
    "user_id" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_green_point_balances_pkey" PRIMARY KEY ("user_id")
);
