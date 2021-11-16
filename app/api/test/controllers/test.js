"use strict";

const _ = require("lodash");
const { sanitizeTest } = require("../../../utils/sanitizers");
const { isPublic, isUserAllowed } = require("../../../utils/auth");
const {
  getMatchingOutcomes,
  getTestMaximumPoints,
  getTestTotalPoints,
  sortTests,
  getOutcomeType,
  sanitizeTestOutcomes,
  getTriggerValues,
  getOutcomeValues,
  getAverageStars,
  isTestCompletedByUser,
} = require("../utils");

const POPULATE = ["roles", "categories.image"];

const errorResponse = (ctx, errors, type) => {
  switch (type) {
    case "forbidden":
      return ctx.forbidden();
    default:
      return ctx.badRequest(null, [{ messages: errors }]);
  }
};

const getTestTemplate = async (id) => {
  const templateService = strapi.services["test-templates"];
  return await templateService.findOne({ id }, ["options"]);
};

const composeSimpleTest = (user) => async (test) => ({
  id: test.id,
  name: test.name,
  slug: test.slug,
  type: test.type,
  description: test.description,
  is_public: isPublic(test.roles),
  categories: test.categories.map((category) => ({
    id: category.id,
    label: category.label,
  })),
  published_at: test.published_at,
  updated_at: test.updated_at,
  completed_by_user: await isTestCompletedByUser(test.id, user?.id),
});

const toSimpleOption = ({ id, label }) => ({ id, label });

const getPointOptions = (template, question) =>
  question.point_options.length
    ? question.point_options
    : template.options.point_options;

const getSuitabilityOptions = (template, question) =>
  question.suitability_options.length
    ? question.suitability_options
    : template.options.suitability_options;

const getOptions = (template, question, outcome_type, showPoints) => {
  const options =
    outcome_type === "suitability_of_answers"
      ? getSuitabilityOptions(template, question)
      : getPointOptions(template, question);

  if (showPoints) {
    return options;
  }
  return options.map(toSimpleOption);
};

const composeQuestion = (template, outcome_type, showPoints) => (question) => {
  const composedQuestion = {
    ...question,
    options: getOptions(template, question, outcome_type, showPoints),
    answer_type: question.answer_type?.type
      ? question.answer_type.type
      : template.options.answer_type.type,
  };

  delete composedQuestion.point_options;
  delete composedQuestion.suitability_options;

  return composedQuestion;
};

const composeTest = async (test) => {
  const template = await getTestTemplate(test.template);

  const outcome_type = getOutcomeType(test, template);

  const questions = test.questions.map(composeQuestion(template, outcome_type));

  delete test.template;
  delete test.outcomes;
  delete test.outcome_type;
  delete test.affects_user_profile;

  return { ...test, questions };
};

/**
 * Read the documentation (https://strapi.io/documentation/developer-docs/latest/development/backend-customization.html#core-controllers)
 * to customize this controller
 */

module.exports = {
  async find(ctx) {
    const user = ctx.state.user;

    let entities;
    if (ctx.query._q) {
      entities = await strapi.services.test.search(ctx.query);
    } else {
      entities = await strapi.services.test.find(ctx.query, POPULATE);
    }

    // Complete entity is needed only when fetching just one test with either slug or id.
    if (!ctx.query.slug && !ctx.query.id) {
      // No slug or id -> return list of all entities, but strip them first.
      return await Promise.all(
        entities.sort(sortTests).map(composeSimpleTest(user))
      );
    }

    const allowedEntities = entities.filter((entity) => {
      return isPublic(entity.roles) || isUserAllowed(user, entity.roles);
    });

    if (entities.length && !allowedEntities.length) {
      return errorResponse(ctx, [], "forbidden");
    }

    return Promise.all(
      allowedEntities.map(async (entity) =>
        sanitizeTest(await composeTest(entity))
      )
    );
  },

  async findOne(ctx) {
    const { id } = ctx.params;
    const user = ctx.state.user;

    const test = await strapi.services.test.findOne({ id }, POPULATE);

    const roles = test.roles;
    if (isPublic(roles) || isUserAllowed(user, roles)) {
      return sanitizeTest(await composeTest(test));
    }

    return errorResponse(ctx, [], "forbidden");
  },

  async getOutcome(ctx) {
    const { slug } = ctx.params;
    const user = ctx.state.user;
    const { answers } = ctx.request.body;

    const test = await strapi.services.test.findOne({ slug }, POPULATE);
    const template = await getTestTemplate(test.template);
    const outcome_type = getOutcomeType(test, template);
    const questions = test.questions.map(
      composeQuestion(template, outcome_type, true)
    );

    const roles = test.roles;
    if (!isPublic(roles) && !isUserAllowed(user, roles)) {
      return errorResponse(ctx, [], "forbidden");
    }

    const isTotalPoints = outcome_type === "total_points";
    const isSuitabilityOfAnswers = outcome_type === "suitability_of_answers";

    const {
      show_all_possible_outcomes,
      test_result_settings,
      outcomes: all_outcomes,
      trigger_outcomes: all_trigger_outcomes,
      link_list_title,
      link_list,
    } = test.outcomes ?? {};

    const { show_total_points, show_maximum_points, show_stars } =
      test_result_settings ?? {};

    const max_points = getTestMaximumPoints(questions);

    // Count total points for type "total_points"
    const total_points = getTestTotalPoints(answers, questions);

    // Calculate outcome value(s) for type "suitability_of_answers"
    const outcome_values = getOutcomeValues(answers, questions);

    // Get trigger option values that user triggered
    const trigger_values = getTriggerValues(answers, questions);

    // Get matching outcomes (either by test type or points or outcome values)
    const matching_outcomes = getMatchingOutcomes({
      outcomes: all_outcomes,
      test_type: test.type,
      points: isTotalPoints ? total_points : undefined,
      outcome_values: isSuitabilityOfAnswers ? outcome_values : undefined,
    });

    // Get matching trigger outcomes
    const trigger_outcomes = getMatchingOutcomes({
      outcomes: all_trigger_outcomes,
      trigger_values,
    });

    // Compose response
    const outcomes = {
      id: test.id,
      slug: test.slug,
      points: isTotalPoints && show_total_points ? total_points : null,
      maximum_points: isTotalPoints && show_maximum_points ? max_points : null,
      stars: show_stars ? getAverageStars(matching_outcomes) : null,
      matching_outcomes: sanitizeTestOutcomes(matching_outcomes, show_stars),
      trigger_outcomes: sanitizeTestOutcomes(trigger_outcomes, show_stars),
      all_outcomes: show_all_possible_outcomes
        ? sanitizeTestOutcomes(all_outcomes, show_stars)
        : null,
      link_list_title,
      link_list,
    };

    const completedTestsService = strapi.services["completed-tests"];

    // Store test results to DB only for registered users!
    if (user?.id) {
      // 1. Find user's old tests having the same ID as current test
      const oldTests = await completedTestsService.find({
        user: user.id,
        test: test.id,
      });

      // 2. Delete old (duplicate) tests from the DB before storing the new one
      if (oldTests?.length) {
        for (const oldTest of oldTests) {
          await completedTestsService.delete({ id: oldTest.id });
        }
      }

      // 3. Save completed test to the DB
      const completedTest = await strapi.services["completed-tests"].create({
        user: user?.id,
        test: test.id,
        test_categories: test.categories.map(({ id }) => id),
        test_snapshot: test,
        answers,
        outcomes,
      });

      return completedTest.outcomes;
    }

    return outcomes;
  },
};
