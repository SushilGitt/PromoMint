import { GraphqlQueryError } from "@shopify/shopify-api";
import shopify from "./shopify.js";

const PREMIUM_PLAN = "Premium";

export default async function cancelSubscription(session) {
  const subscriptionId = await getActiveSubscriptionId(session);
  if (!subscriptionId) {
    throw new Error("No active Premium subscription ID found for cancellation.");
  }

  return appSubscriptionCancel(session, subscriptionId);
}

async function getActiveSubscriptionId(session) {
  const client = new shopify.api.clients.Graphql({ session });

  const currentInstallations = await client.query({
    data: RECURRING_PURCHASES_QUERY,
  });

  const subscriptions =
    currentInstallations.body.data?.currentAppInstallation?.activeSubscriptions || [];

  const matchingSubscription = subscriptions.find(
    (subscription) => subscription?.name === PREMIUM_PLAN
  );

  if (matchingSubscription?.id) {
    return matchingSubscription.id;
  }

  if (subscriptions.length > 0) {
    throw new Error(
      "Active subscriptions were found, but none matched the Premium plan."
    );
  }

  return "";
}

async function appSubscriptionCancel(session, subscriptionId) {
  const client = new shopify.api.clients.Graphql({ session });

  const mutationResponse = await client.query({
    data: {
      query: CANCEL_SUBSCRIPTION,
      variables: {
        id: subscriptionId,
      },
    },
  });

  const topLevelErrors = mutationResponse.body.errors || [];
  const userErrors =
    mutationResponse.body.data?.appSubscriptionCancel?.userErrors || [];

  if (topLevelErrors.length || userErrors.length) {
    throw new GraphqlQueryError({
      message:
        userErrors[0]?.message || "Error while cancelling subscription.",
      response: mutationResponse.body,
      headers: {},
      body: mutationResponse.body,
    });
  }

  return mutationResponse.body.data.appSubscriptionCancel.appSubscription.status;
}

const CANCEL_SUBSCRIPTION = `
mutation appSubscriptionCancel($id: ID!) {
  appSubscriptionCancel(id: $id) {
    appSubscription {
      id
      name
      status
    }
    userErrors {
      field
      message
    }
  }
}
`;

const RECURRING_PURCHASES_QUERY = `
query appSubscription {
  currentAppInstallation {
    activeSubscriptions {
      name
      id
      test
      status
    }
  }
}
`;
